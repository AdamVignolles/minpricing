import { afterEach, describe, expect, it } from "vitest";

import {
  configureBrowserEngines,
  lightpandaEndpoint,
  takeLightpandaFallbacks,
} from "../src/api/collectors/browser.ts";

describe("lightpandaEndpoint", () => {
  afterEach(() => {
    delete process.env.LIGHTPANDA_WS_URL;
    configureBrowserEngines({});
  });

  it("is used only for a configured source with the env set", () => {
    configureBrowserEngines({ carrefour: "lightpanda", amazon: "chromium" });
    expect(lightpandaEndpoint("carrefour")).toBeUndefined();

    process.env.LIGHTPANDA_WS_URL = "ws://127.0.0.1:9222";
    expect(lightpandaEndpoint("carrefour")).toBe("ws://127.0.0.1:9222");
    expect(lightpandaEndpoint("amazon")).toBeUndefined();
    expect(lightpandaEndpoint("unknown")).toBeUndefined();
    expect(lightpandaEndpoint()).toBeUndefined();
  });

  it("starts with no recorded fallbacks", () => {
    expect(takeLightpandaFallbacks()).toEqual({});
  });
});
