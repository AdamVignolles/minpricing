import { execFile } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  commentLeaves,
  isDealabsThreadUrl,
} from "../src/api/services/DealabsCommentsService.ts";

/**
 * `dealradar.mjs` in remote mode (the cloud routines): a report written
 * before the command — routines write it, then run `pull` — still reaches
 * the VM, once, by content rather than by modification time.
 */
describe("remote mode: reports pushed by content", () => {
  const puts: string[] = [];
  let server: Server;
  let dir: string;

  const run = (command: string) =>
    promisify(execFile)(
      process.execPath,
      [join(dir, "scripts", "agents", "dealradar.mjs"), command],
      {
        env: {
          ...process.env,
          DEALRADAR_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
          DEALRADAR_TOKEN: "t".repeat(64),
        },
      },
    );

  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.startsWith("/api/agent/changes")) {
          res.end("[]");
        } else if (req.method === "PUT" && req.url?.includes("/reports/")) {
          puts.push(`${req.url} ${JSON.parse(body).markdown}`);
          res.end("{}");
        } else {
          res.statusCode = 404;
          res.end("{}");
        }
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));

    dir = mkdtempSync(join(tmpdir(), "dealradar-remote-"));
    mkdirSync(join(dir, "scripts", "agents"), { recursive: true });
    cpSync(
      "scripts/agents/dealradar.mjs",
      join(dir, "scripts", "agents", "dealradar.mjs"),
    );
    const reports = join(dir, "data", "agents", "reports");
    mkdirSync(reports, { recursive: true });
    const hourAgo = new Date(Date.now() - 3_600_000);
    const daysAgo = new Date(Date.now() - 3 * 86_400_000);
    writeFileSync(join(reports, "debrief-2026-10-28.md"), "# Debrief");
    utimesSync(join(reports, "debrief-2026-10-28.md"), hourAgo, hourAgo);
    writeFileSync(join(reports, "sources-2026-10-25.md"), "# Old");
    utimesSync(join(reports, "sources-2026-10-25.md"), daysAgo, daysAgo);
  });

  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a report written before `pull` is pushed, then not again", async () => {
    const first = await run("pull");
    expect(puts).toEqual(["/api/agent/reports/debrief-2026-10-28 # Debrief"]);
    expect(first.stderr).toContain("reports/debrief-2026-10-28.md");

    await run("pull");
    expect(puts).toHaveLength(1);

    writeFileSync(
      join(dir, "data", "agents", "reports", "debrief-2026-10-28.md"),
      "# Debrief v2",
    );
    await run("pull");
    expect(puts.at(-1)).toBe(
      "/api/agent/reports/debrief-2026-10-28 # Debrief v2",
    );
    const base = JSON.parse(
      readFileSync(join(dir, "data", "agents", ".data-base.json"), "utf8"),
    );
    expect(base["reports/debrief-2026-10-28.md"]).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("Dealabs comments read on the VM", () => {
  test("only Dealabs thread URLs", () => {
    expect(
      isDealabsThreadUrl("https://www.dealabs.com/bons-plans/tv-oled-123"),
    ).toBe(true);
    expect(isDealabsThreadUrl("https://www.dealabs.com/profile/x")).toBe(false);
    expect(isDealabsThreadUrl("http://www.dealabs.com/bons-plans/x")).toBe(
      false,
    );
    expect(isDealabsThreadUrl("https://evil.com/bons-plans/x")).toBe(false);
    expect(isDealabsThreadUrl("not a url")).toBe(false);
  });

  test("keeps the innermost comment texts", () => {
    expect(
      commentLeaves([
        "Alice Super prix Bob Déjà vu moins cher",
        "Super prix",
        "Déjà vu moins cher",
        "Super prix",
        "",
      ]),
    ).toEqual(["Super prix", "Déjà vu moins cher"]);
  });
});
