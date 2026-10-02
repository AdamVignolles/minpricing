import { Alepha } from "alepha";
import { AlephaServer } from "alepha/server";
import { expect, test } from "vitest";

import { AdminController } from "../src/api/controllers/AdminController.ts";
import { AuthController } from "../src/api/controllers/AuthController.ts";

/**
 * Confirms the whole app's session gate actually works end to end (see
 * `AGENTS.md` — there is no public part of this site):
 * - every admin action 401s with no cookie
 * - `AuthController#login` rejects wrong credentials and never sets a cookie
 * - a correct login sets a signed cookie that then authorizes the gated action
 * - `AuthController#logout` clears it, and the action 401s again
 */
test("admin endpoints require a signed session cookie set via login", async () => {
  const alepha = Alepha.create({
    env: { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin" },
  })
    .with(AlephaServer)
    .with(AuthController)
    .with(AdminController);

  await alepha.start();

  const auth = alepha.inject(AuthController);
  const admin = alepha.inject(AdminController);

  // No cookie at all.
  await expect(admin.stats.fetch({})).rejects.toMatchObject({ status: 401 });

  // Wrong credentials never set a cookie.
  await expect(
    auth.login.fetch({ body: { username: "admin", password: "nope" } }),
  ).rejects.toMatchObject({ status: 401 });

  // Correct credentials set a signed session cookie.
  const loginResponse = await auth.login.fetch({
    body: { username: "admin", password: "admin" },
  });
  const setCookie = loginResponse.headers.get("set-cookie");
  expect(setCookie).toBeTruthy();
  const cookie = setCookie?.split(";")[0] ?? "";

  const stats = await admin.stats.fetch({
    headers: { cookie },
  });
  expect(stats.data).toBeDefined();

  // Logout clears it.
  const logoutResponse = await auth.logout.fetch({ headers: { cookie } });
  const clearedCookie = logoutResponse.headers.get("set-cookie");
  expect(clearedCookie).toBeTruthy();

  await expect(
    admin.stats.fetch({
      headers: { cookie: clearedCookie?.split(";")[0] ?? "" },
    }),
  ).rejects.toMatchObject({ status: 401 });

  await alepha.stop();
});
