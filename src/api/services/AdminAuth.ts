import { $env, createMiddleware, type Middleware, z } from "alepha";
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
 */
export function $adminSession(): Middleware {
  const session = $adminSessionCookie();

  return createMiddleware({
    name: "$adminSession",
    handler: ({ next }) => {
      return async (...args: unknown[]) => {
        if (!session.get()) {
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
