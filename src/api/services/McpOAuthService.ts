import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { $env, z } from "alepha";

/** Lifetime of an access token handed to an MCP client. */
export const ACCESS_TOKEN_TTL = 60 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60;
const CODE_TTL = 5 * 60;

type TokenKind = "client" | "code" | "access" | "refresh";

interface ClientClaims {
  redirectUris: string[];
  name?: string;
}

interface CodeClaims {
  clientId: string;
  redirectUri: string;
  challenge: string;
}

/**
 * The smallest OAuth 2.1 server Claude's connectors accept, for the one
 * admin of this app (no user table, see `AdminAuth.ts`): dynamic client
 * registration, authorization code with PKCE (S256), refresh tokens.
 *
 * Nothing is stored. Client ids, codes and tokens are HMAC-signed claims
 * (key derived from `APP_SECRET`), so no table or migration is needed and
 * rotating `APP_SECRET` revokes every connection at once. Codes are
 * single-use within the process (`usedCodes`), which is enough on a single
 * Bay process; on a restart an unused code simply expires in 5 minutes.
 */
export class McpOAuthService {
  protected env = $env(z.object({ APP_SECRET: z.text().optional() }));
  protected usedCodes = new Map<string, number>();

  protected key(): Buffer {
    // The framework's own default secret is public; tests and dev fall back
    // to it too, which is fine since the MCP is only exposed in production.
    const secret = this.env.APP_SECRET || "minpricing-dev-secret";
    return createHash("sha256").update(`mcp-oauth:${secret}`).digest();
  }

  sign(kind: TokenKind, claims: object, ttlSeconds?: number): string {
    const body = {
      ...claims,
      k: kind,
      jti: randomUUID(),
      exp: ttlSeconds ? Math.floor(Date.now() / 1000) + ttlSeconds : undefined,
    };
    const payload = Buffer.from(JSON.stringify(body)).toString("base64url");
    const mac = createHmac("sha256", this.key())
      .update(`${kind}.${payload}`)
      .digest("base64url");
    return `${payload}.${mac}`;
  }

  verify<T>(
    kind: TokenKind,
    token: string | undefined,
  ): (T & { jti: string; exp?: number }) | undefined {
    if (!token) return undefined;
    const [payload, mac, extra] = token.split(".");
    if (!payload || !mac || extra !== undefined) return undefined;
    const expected = createHmac("sha256", this.key())
      .update(`${kind}.${payload}`)
      .digest();
    const given = Buffer.from(mac, "base64url");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    try {
      const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
      if (claims.k !== kind) return undefined;
      if (claims.exp && claims.exp < Date.now() / 1000) return undefined;
      return claims;
    } catch {
      return undefined;
    }
  }

  registerClient(redirectUris: string[], name?: string): string {
    for (const uri of redirectUris) {
      if (!isAllowedRedirect(uri)) {
        throw new Error(`redirect_uri not allowed: ${uri}`);
      }
    }
    return this.sign("client", { redirectUris, name } satisfies ClientClaims);
  }

  client(clientId: string | undefined): ClientClaims | undefined {
    return this.verify<ClientClaims>("client", clientId);
  }

  issueCode(claims: CodeClaims): string {
    return this.sign("code", claims, CODE_TTL);
  }

  /** Checks a code once: a second exchange of the same code fails. */
  redeemCode(
    code: string | undefined,
    clientId: string | undefined,
    redirectUri: string | undefined,
    verifier: string | undefined,
  ): boolean {
    const claims = this.verify<CodeClaims>("code", code);
    if (!claims || !verifier) return false;
    if (claims.clientId !== clientId || claims.redirectUri !== redirectUri) {
      return false;
    }
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    if (challenge !== claims.challenge) return false;
    const now = Date.now() / 1000;
    for (const [jti, exp] of this.usedCodes) {
      if (exp < now) this.usedCodes.delete(jti);
    }
    if (this.usedCodes.has(claims.jti)) return false;
    this.usedCodes.set(claims.jti, claims.exp ?? now + CODE_TTL);
    return true;
  }

  issueTokens(clientId: string) {
    return {
      access_token: this.sign("access", { clientId }, ACCESS_TOKEN_TTL),
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: this.sign("refresh", { clientId }, REFRESH_TOKEN_TTL),
      scope: "mcp",
    };
  }

  refresh(token: string | undefined, clientId: string | undefined) {
    const claims = this.verify<{ clientId: string }>("refresh", token);
    if (!claims || (clientId && claims.clientId !== clientId)) return undefined;
    return this.issueTokens(claims.clientId);
  }

  /** True when `authorization` carries a valid access token. */
  isAuthorized(authorization: string | undefined): boolean {
    const match = /^Bearer\s+(.+)$/i.exec(authorization ?? "");
    return !!this.verify("access", match?.[1]?.trim());
  }
}

/** HTTPS anywhere, plain HTTP only on the loopback (CLI clients). */
export function isAllowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.hash) return false;
    if (url.protocol === "https:") return true;
    return (
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}
