import { z } from "alepha";
import { $action, HttpError } from "alepha/server";

import {
  $adminCredentialsEnv,
  $adminSessionCookie,
} from "../services/AdminAuth.ts";

/**
 * The only controller NOT gated by `$adminSession()` (see `AGENTS.md` —
 * this app has no public part, so every other action requires the signed
 * session cookie). `login` is how that cookie is obtained in the first
 * place; `logout` only ever clears it, so leaving it open too is harmless.
 */
export class AuthController {
  protected credentials = $adminCredentialsEnv();
  protected session = $adminSessionCookie();

  login = $action({
    method: "POST",
    path: "/auth/login",
    schema: {
      body: z.object({ username: z.text(), password: z.text() }),
      response: z.object({ ok: z.boolean() }),
    },
    handler: async ({ body }) => {
      const valid =
        body.username === this.credentials.ADMIN_USERNAME &&
        body.password === this.credentials.ADMIN_PASSWORD;

      if (!valid) {
        throw new HttpError({ status: 401, message: "Invalid credentials" });
      }

      this.session.set(true);
      return { ok: true };
    },
  });

  logout = $action({
    method: "POST",
    path: "/auth/logout",
    schema: { response: z.object({ ok: z.boolean() }) },
    handler: async () => {
      this.session.del();
      return { ok: true };
    },
  });
}
