import { createHash, timingSafeEqual } from "node:crypto";

import {
  $env,
  $inject,
  Alepha,
  createMiddleware,
  type Middleware,
  z,
} from "alepha";
import { HttpError } from "alepha/server";
import { $cookie } from "alepha/server/cookies";

/**
 * Name of the signed session cookie set by `AuthController#login` and
 * cleared by `AuthController#logout`.
 */
const SESSION_COOKIE_NAME = "admin_session";

/**
 * Declares a handle on the signed, httpOnly session cookie.
 *
 * This whole app is single-user and private (see `AGENTS.md`): one session
 * cookie, no user table, no per-user claims — just "is this the one admin
 * or not". `sign: true` HMACs the value with `APP_SECRET` (via
 * `ServerCookiesProvider`), so a visitor cannot forge it without the
 * server's secret; `httpOnly` keeps it out of reach of any script running
 * on the page (XSS can't read or replay it).
 *
 * Call this once per controller that needs it (`AuthController` to
 * set/clear it, every other controller's `$adminSession()` guard to read
 * it) — each call just creates its own handle onto the one cookie
 * `ServerCookiesProvider` actually stores, the same pattern already used
 * for `$repository` across controllers.
 */
export function $adminSessionCookie() {
  return $cookie({
    schema: z.boolean(),
    name: SESSION_COOKIE_NAME,
    httpOnly: true,
    sign: true,
    sameSite: "lax",
    ttl: [7, "days"],
  });
}

/**
 * Reads the `ADMIN_USERNAME`/`ADMIN_PASSWORD` env vars the login form is
 * checked against. Defaults to "admin"/"admin" so the dashboard works out
 * of the box right after a deploy; set both for anything beyond quick
 * testing, since the default is public (this file).
 */
export function $adminCredentialsEnv() {
  return $env(
    z.object({
      ADMIN_USERNAME: z.text({ default: "admin" }),
      ADMIN_PASSWORD: z.text({ default: "admin" }),
    }),
  );
}

/**
 * Gate applied to every action in the app (see `AGENTS.md` — this is a
 * private, single-user app, there is no public part of the site). Requires
 * the signed session cookie set by `AuthController#login`; 401s otherwise
 * so the `layout` page's `errorHandler` can redirect an anonymous visitor
 * to `/login`.
 *
 * Plain equality/presence check is enough here — unlike `$basicAuth`,
 * there are no credentials to compare on every request, just "is the
 * signed cookie present and valid", and signature verification is already
 * timing-safe inside `ServerCookiesProvider`.
 *
 * Also lets through a call made from a read-only MCP tool (`McpTools.ts`):
 * the `/mcp` request was already checked for a valid OAuth token by
 * `McpOAuthController.gate`, which flags it `mcpAgent`. The flag only
 * exists on `/mcp` requests, so it never opens any other HTTP route, and
 * the tools only call GET actions.
 */
export function $adminSession(): Middleware {
  const session = $adminSessionCookie();
  const alepha = $inject(Alepha);
  const env = $agentTokenEnv();

  return createMiddleware({
    name: "$adminSession",
    handler: ({ next }) => {
      return async (...args: unknown[]) => {
        const request = alepha.store.get("alepha.http.request");
        // The agent token reads (GET) like the console does; it never
        // reaches an admin write — agents write only through `/agent/*`.
        const agentRead =
          request?.method === "GET" &&
          hasAgentToken(request?.headers?.authorization, env.AGENT_TOKEN);
        if (
          !session.get() &&
          request?.metadata?.mcpAgent !== true &&
          !agentRead
        ) {
          throw new HttpError({
            status: 401,
            message: "Authentication required",
          });
        }
        return next(...args);
      };
    },
  });
}

/**
 * `AGENT_TOKEN`: the bearer token the scheduled agents (Claude routines,
 * `scripts/agents/dealradar.mjs` in remote mode) send. Unset = agent
 * access off. Generate one with `openssl rand -hex 32`; shorter values
 * are ignored so a placeholder can never open the API.
 */
export function $agentTokenEnv() {
  return $env(
    z.object({
      AGENT_TOKEN: z.text({ default: "" }),
    }),
  );
}

export const AGENT_TOKEN_MIN_LENGTH = 32;

/** Constant-time check of an `Authorization: Bearer …` header. */
export function hasAgentToken(
  header: string | string[] | undefined,
  token: string,
): boolean {
  if (!token || token.length < AGENT_TOKEN_MIN_LENGTH) return false;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  const given = createHash("sha256").update(match[1].trim()).digest();
  const expected = createHash("sha256").update(token).digest();
  return timingSafeEqual(given, expected);
}

/**
 * Gate of the agent write API (`/agent/*`): the agent token, or the admin
 * session (so the console can edit tonight's plan too). The caller is
 * stored as `request.metadata.agentCaller` for the audit trail.
 */
export function $agentAuth(): Middleware {
  const session = $adminSessionCookie();
  const alepha = $inject(Alepha);
  const env = $agentTokenEnv();

  return createMiddleware({
    name: "$agentAuth",
    handler: ({ next }) => {
      return async (...args: unknown[]) => {
        const request = alepha.store.get("alepha.http.request");
        const agent = hasAgentToken(
          request?.headers?.authorization,
          env.AGENT_TOKEN,
        );
        if (!agent && !session.get()) {
          throw new HttpError({
            status: 401,
            message: "Agent token or admin session required",
          });
        }
        if (request) {
          request.metadata ??= {};
          request.metadata.agentCaller = agent ? "agent" : "admin";
        }
        return next(...args);
      };
    },
  });
}
