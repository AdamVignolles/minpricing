import { $inject, z } from "alepha";
import { $hook } from "alepha";
import { $logger } from "alepha/logger";
import { $route, type ServerRequest } from "alepha/server";

import {
  $adminCredentialsEnv,
  $adminSessionCookie,
} from "../services/AdminAuth.ts";
import { McpOAuthService } from "../services/McpOAuthService.ts";

const MCP_PATH = "/mcp";

/** The public origin as the client sees it (Bay's proxy terminates TLS). */
function publicBase(request: ServerRequest): string {
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(",")[0]?.trim();
  };
  const url =
    typeof request.url === "string" ? new URL(request.url) : request.url;
  const host = header("x-forwarded-host") ?? header("host") ?? url.host;
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto =
    header("x-forwarded-proto") ??
    (local ? url.protocol.slice(0, -1) : "https");
  return `${proto}://${host}`;
}

function json(request: ServerRequest, status: number, body: unknown): string {
  request.reply.status = status;
  request.reply.headers["content-type"] = "application/json";
  request.reply.headers["cache-control"] = "no-store";
  return JSON.stringify(body);
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ] as string,
  );
}

const authorizeParams = [
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "response_type",
  "scope",
] as const;

type AuthorizeParams = Partial<
  Record<(typeof authorizeParams)[number], string>
>;

function pick(source: Record<string, unknown> | undefined): AuthorizeParams {
  const out: AuthorizeParams = {};
  for (const key of authorizeParams) {
    const value = source?.[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

/**
 * OAuth endpoints and gate of the read-only MCP (`/mcp`, tools in
 * `McpTools.ts`), so a Claude account can add DealRadar as a connector:
 * Claude registers itself, opens `/oauth/authorize` where the admin logs in
 * (same `ADMIN_USERNAME`/`ADMIN_PASSWORD` as the console) and approves, then
 * calls `/mcp` with the access token. See `McpOAuthService`.
 */
export class McpOAuthController {
  protected log = $logger();
  protected oauth = $inject(McpOAuthService);
  protected credentials = $adminCredentialsEnv();
  protected session = $adminSessionCookie();

  /** 401 with the RFC 9728 challenge on `/mcp` without a valid token. */
  gate = $hook({
    on: "server:onRequest",
    handler: ({ route, request }) => {
      if (route.path !== MCP_PATH || request.method !== "POST") return;
      const auth = request.headers.authorization;
      if (this.oauth.isAuthorized(Array.isArray(auth) ? auth[0] : auth)) {
        request.metadata = { ...request.metadata, mcpAgent: true };
        return;
      }
      request.reply.status = 401;
      request.reply.headers["www-authenticate"] =
        `Bearer resource_metadata="${publicBase(request)}/.well-known/oauth-protected-resource"`;
      request.reply.headers["content-type"] = "application/json";
      request.reply.body = JSON.stringify({ error: "invalid_token" });
    },
  });

  protectedResource = $route({
    method: "GET",
    path: "/.well-known/oauth-protected-resource",
    handler: (request) => this.resourceMetadata(request),
  });

  protectedResourceMcp = $route({
    method: "GET",
    path: "/.well-known/oauth-protected-resource/mcp",
    handler: (request) => this.resourceMetadata(request),
  });

  authorizationServer = $route({
    method: "GET",
    path: "/.well-known/oauth-authorization-server",
    handler: (request) => {
      const base = publicBase(request);
      return json(request, 200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: ["mcp"],
      });
    },
  });

  register = $route({
    method: "POST",
    path: "/oauth/register",
    schema: { body: z.json() },
    handler: (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const uris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u): u is string => typeof u === "string")
        : [];
      const name =
        typeof body.client_name === "string"
          ? body.client_name.slice(0, 80)
          : undefined;
      if (uris.length === 0) {
        return json(request, 400, {
          error: "invalid_redirect_uri",
          error_description: "redirect_uris is required",
        });
      }
      try {
        const clientId = this.oauth.registerClient(uris, name);
        this.log.info("MCP client registered", { name, uris });
        return json(request, 201, {
          client_id: clientId,
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: name,
          redirect_uris: uris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        });
      } catch (error) {
        return json(request, 400, {
          error: "invalid_redirect_uri",
          error_description: (error as Error).message,
        });
      }
    },
  });

  authorizePage = $route({
    method: "GET",
    path: "/oauth/authorize",
    handler: (request) =>
      this.renderAuthorize(
        request,
        pick(request.query as Record<string, unknown>),
      ),
  });

  authorizeDecision = $route({
    method: "POST",
    path: "/oauth/authorize",
    schema: { body: z.json() },
    handler: async (request) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const params = pick(body);
      const problem = this.checkAuthorize(params);
      if (problem) return this.page(request, 400, problem);

      if (body.decision !== "allow") {
        return this.redirectBack(request, params, { error: "access_denied" });
      }
      const loggedIn = !!this.session.get();
      const valid =
        loggedIn ||
        (body.username === this.credentials.ADMIN_USERNAME &&
          body.password === this.credentials.ADMIN_PASSWORD);
      if (!valid) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        this.log.warn("MCP authorization: wrong credentials");
        return this.renderAuthorize(
          request,
          params,
          "Identifiants incorrects.",
        );
      }
      const code = this.oauth.issueCode({
        clientId: params.client_id as string,
        redirectUri: params.redirect_uri as string,
        challenge: params.code_challenge as string,
      });
      this.log.info("MCP client authorized", {
        client: this.oauth.client(params.client_id)?.name,
      });
      return this.redirectBack(request, params, { code });
    },
  });

  token = $route({
    method: "POST",
    path: "/oauth/token",
    schema: { body: z.json() },
    handler: (request) => {
      const body = (request.body ?? {}) as Record<string, string | undefined>;
      if (body.grant_type === "authorization_code") {
        if (!this.oauth.client(body.client_id)) {
          return json(request, 401, { error: "invalid_client" });
        }
        const ok = this.oauth.redeemCode(
          body.code,
          body.client_id,
          body.redirect_uri,
          body.code_verifier,
        );
        if (!ok) return json(request, 400, { error: "invalid_grant" });
        return json(request, 200, this.oauth.issueTokens(body.client_id!));
      }
      if (body.grant_type === "refresh_token") {
        const tokens = this.oauth.refresh(body.refresh_token, body.client_id);
        if (!tokens) return json(request, 400, { error: "invalid_grant" });
        return json(request, 200, tokens);
      }
      return json(request, 400, { error: "unsupported_grant_type" });
    },
  });

  protected resourceMetadata(request: ServerRequest): string {
    const base = publicBase(request);
    return json(request, 200, {
      resource: `${base}${MCP_PATH}`,
      authorization_servers: [base],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
      resource_name: "DealRadar",
    });
  }

  /** French message when the request can't even be sent back to the client. */
  protected checkAuthorize(params: AuthorizeParams): string | undefined {
    const client = this.oauth.client(params.client_id);
    if (!client)
      return "Application inconnue : ajoutez à nouveau le connecteur.";
    if (
      !params.redirect_uri ||
      !client.redirectUris.includes(params.redirect_uri)
    ) {
      return "Adresse de retour non autorisée pour cette application.";
    }
    if (params.response_type !== "code")
      return "response_type non pris en charge.";
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
      return "PKCE (S256) requis.";
    }
    return undefined;
  }

  protected redirectBack(
    request: ServerRequest,
    params: AuthorizeParams,
    values: Record<string, string>,
  ): string {
    const target = new URL(params.redirect_uri as string);
    for (const [key, value] of Object.entries(values)) {
      target.searchParams.set(key, value);
    }
    if (params.state) target.searchParams.set("state", params.state);
    request.reply.redirect(target.toString());
    return "";
  }

  protected renderAuthorize(
    request: ServerRequest,
    params: AuthorizeParams,
    error?: string,
  ): string {
    const problem = this.checkAuthorize(params);
    if (problem) return this.page(request, 400, problem);
    const client = this.oauth.client(params.client_id);
    const appName = client?.name ?? "Une application";
    const host = new URL(params.redirect_uri as string).host;
    const loggedIn = !!this.session.get();
    const hidden = authorizeParams
      .filter((key) => params[key])
      .map(
        (key) =>
          `<input type="hidden" name="${key}" value="${escapeHtml(params[key] as string)}">`,
      )
      .join("");
    const login = loggedIn
      ? `<p class="muted">Connecté à la console DealRadar.</p>`
      : `<label>Utilisateur<input name="username" autocomplete="username" required></label>
         <label>Mot de passe<input name="password" type="password" autocomplete="current-password" required></label>`;
    return this.page(
      request,
      error ? 401 : 200,
      `<h1>Connecter ${escapeHtml(appName)} à DealRadar</h1>
       <p><b>${escapeHtml(appName)}</b> (${escapeHtml(host)}) demande un accès <b>en lecture seule</b> au radar : deals, scores, historiques, sources, collectes, rapports des agents et configuration. Il ne pourra rien modifier ni publier.</p>
       ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
       <form method="post" action="/oauth/authorize">${hidden}${login}
         <div class="actions">
           <button name="decision" value="deny" type="submit" formnovalidate class="secondary">Refuser</button>
           <button name="decision" value="allow" type="submit">Autoriser</button>
         </div>
       </form>`,
    );
  }

  protected page(
    request: ServerRequest,
    status: number,
    content: string,
  ): string {
    request.reply.status = status;
    request.reply.headers["content-type"] = "text/html; charset=utf-8";
    request.reply.headers["cache-control"] = "no-store";
    request.reply.headers["x-frame-options"] = "DENY";
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>DealRadar · Autorisation</title>
<style>body{font-family:system-ui,sans-serif;background:#f4f5f7;margin:0;display:grid;place-items:center;min-height:100vh}
main{background:#fff;max-width:420px;padding:28px;border-radius:12px;box-shadow:0 2px 12px #0002}
h1{font-size:20px;margin-top:0}label{display:block;margin:12px 0;font-size:14px}
input{display:block;width:100%;box-sizing:border-box;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:6px}
.actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
button{padding:8px 16px;border-radius:6px;border:0;background:#1c7ed6;color:#fff;cursor:pointer;font-size:14px}
button.secondary{background:#e9ecef;color:#222}.error{color:#c92a2a}.muted{color:#666;font-size:14px}</style>
</head><body><main>${content}</main></body></html>`;
  }
}
