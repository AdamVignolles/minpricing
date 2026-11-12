import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  browserProxyFromEnv,
  proxyReachable,
} from "../src/api/collectors/stealthChromium.ts";

describe("browser proxy", () => {
  it("reads credentials out of the URL", () => {
    expect(browserProxyFromEnv("http://u:p%40ss@h.example:8080")).toEqual({
      server: "http://h.example:8080",
      username: "u",
      password: "p@ss",
    });
    expect(browserProxyFromEnv("socks5://127.0.0.1:1080")).toEqual({
      server: "socks5://127.0.0.1:1080",
    });
    expect(browserProxyFromEnv("")).toBeUndefined();
    expect(browserProxyFromEnv("nonsense")).toBeUndefined();
  });

  it("needs a SOCKS greeting answer, not just an open port", async () => {
    const answering = createServer((c) =>
      c.once("data", () => c.write(Buffer.from([5, 0]))),
    );
    const dropping = createServer((c) => c.destroy());
    const listen = (s: typeof answering) =>
      new Promise<number>((r) =>
        s.listen(0, "127.0.0.1", () => r((s.address() as any).port)),
      );
    const [a, d] = [await listen(answering), await listen(dropping)];
    try {
      expect(await proxyReachable({ server: `socks5://127.0.0.1:${a}` })).toBe(
        true,
      );
      expect(await proxyReachable({ server: `socks5://127.0.0.1:${d}` })).toBe(
        false,
      );
      expect(await proxyReachable({ server: "socks5://127.0.0.1:1" })).toBe(
        false,
      );
    } finally {
      answering.close();
      dropping.close();
    }
  });
});
