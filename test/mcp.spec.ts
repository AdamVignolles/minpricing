import { createHash, randomBytes } from "node:crypto";

import { Alepha } from "alepha";
import { McpServerProvider } from "alepha/mcp";
import { AlephaServer, ServerProvider } from "alepha/server";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { ApiModule } from "../src/api/index.ts";
import { isAllowedRedirect } from "../src/api/services/McpOAuthService.ts";

/**
 * The read-only MCP server Claude connects to: `/mcp` refuses any request
 * without an OAuth token, the OAuth login takes the admin credentials and
 * PKCE, a code works once, and no tool can write.
 */
const PASSWORD = "s3cret-admin-pass";
const APP_SECRET = "test-app-secret-0123456789abcdef";

let alepha: Alepha;
let base: string;

beforeAll(async () => {
  alepha = Alepha.create({
    env: {
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: PASSWORD,
      APP_SECRET,
      DATABASE_URL: "sqlite://:memory:",
      COLLECT_ON_START: "false",
    },
  })
    .with(AlephaServer)
    .with(ApiModule);
  await alepha.start();
  base = alepha.inject(ServerProvider).hostname;
}, 30_000);

afterAll(async () => {
  await alepha?.stop();
});

const rpc = (body: unknown, token?: string) =>
  fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

async function authorize(redirectUri: string) {
  const reg = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirectUri],
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
  });
  const page = await fetch(`${base}/oauth/authorize?${query}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("DealRadar");

  const form = (password: string) =>
    fetch(`${base}/oauth/authorize`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...Object.fromEntries(query),
        username: "admin",
        password,
        decision: "allow",
      }),
    });

  const wrong = await form("nope");
  expect(wrong.headers.get("location")).toBeNull();
  expect(await wrong.text()).toContain("Identifiants incorrects");

  const ok = await form(PASSWORD);
  expect(ok.status).toBe(302);
  const location = new URL(ok.headers.get("location") ?? "");
  expect(location.origin + location.pathname).toBe(redirectUri);
  expect(location.searchParams.get("state")).toBe("xyz");
  const code = location.searchParams.get("code") ?? "";
  expect(code).not.toBe("");
  return { client_id, code, verifier };
}

const token = (body: Record<string, string>) =>
  fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });

describe("MCP OAuth", () => {
  test("/mcp answers 401 with the OAuth discovery challenge", async () => {
    const response = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      "/.well-known/oauth-protected-resource",
    );
    const forged = await rpc(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      "forged.token",
    );
    expect(forged.status).toBe(401);
  });

  test("publishes the metadata Claude discovers", async () => {
    const resource = await (
      await fetch(`${base}/.well-known/oauth-protected-resource`)
    ).json();
    expect(resource.authorization_servers).toHaveLength(1);
    const server = await (
      await fetch(`${base}/.well-known/oauth-authorization-server`)
    ).json();
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    expect(server.registration_endpoint).toMatch(/\/oauth\/register$/);
  });

  test("only https (or localhost) redirect URIs are accepted", () => {
    expect(isAllowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(
      true,
    );
    expect(isAllowedRedirect("http://localhost:6274/callback")).toBe(true);
    expect(isAllowedRedirect("http://evil.example/cb")).toBe(false);
    expect(isAllowedRedirect("javascript:alert(1)")).toBe(false);
  });

  test("full login → token → read-only tools, codes are single use", async () => {
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const { client_id, code } = await authorize(redirectUri);

    const badVerifier = await token({
      grant_type: "authorization_code",
      code,
      client_id,
      redirect_uri: redirectUri,
      code_verifier: "wrong-verifier",
    });
    expect(badVerifier.status).toBe(400);

    const second = await authorize(redirectUri);
    const exchange = () =>
      token({
        grant_type: "authorization_code",
        code: second.code,
        client_id: second.client_id,
        redirect_uri: redirectUri,
        code_verifier: second.verifier,
      });
    const granted = await exchange();
    expect(granted.status).toBe(200);
    const tokens = (await granted.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
    };
    expect(tokens.token_type).toBe("Bearer");
    expect((await exchange()).status).toBe(400);

    const refreshed = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: second.client_id,
    });
    expect(refreshed.status).toBe(200);
    // An access token is not a refresh token.
    const misuse = await token({
      grant_type: "refresh_token",
      refresh_token: tokens.access_token,
      client_id: second.client_id,
    });
    expect(misuse.status).toBe(400);

    const list = await rpc(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      tokens.access_token,
    );
    expect(list.status).toBe(200);
    const listed = JSON.stringify(await list.json());
    expect(listed).toContain("search_deals");

    const call = await rpc(
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "get_config", arguments: { name: "publish-rules" } },
      },
      tokens.access_token,
    );
    expect(call.status).toBe(200);
    const text = await call.text();
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(APP_SECRET);

    const outside = await rpc(
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "get_config", arguments: { name: "../.env" } },
      },
      tokens.access_token,
    );
    expect(await outside.text()).not.toContain(PASSWORD);
  }, 30_000);

  test("every tool is declared read-only", () => {
    const tools = alepha.inject(McpServerProvider).getTools();
    expect(tools.length).toBeGreaterThanOrEqual(12);
    for (const tool of tools) {
      expect(tool.options.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });
});
