import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Alepha } from "alepha";
import { $repository } from "alepha/orm";
import { AlephaServer } from "alepha/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

import { appFileEntity } from "../src/api/entities/AppFile.ts";
import { ApiModule } from "../src/api/index.ts";
import { isKeptFile } from "../src/api/services/appFiles.ts";
import { AppFilesService } from "../src/api/services/AppFilesService.ts";

class Fixtures {
  files = $repository(appFileEntity);
}

describe("isKeptFile", () => {
  test("keeps configs, agent files, changelogs and the pause", () => {
    for (const path of [
      "config/collection.json",
      "config/selection-lessons.md",
      "data/agents/ledger.jsonl",
      "data/agents/reports/bilan-2026-11-01.md",
      "docs/sources-changelog.md",
      ".publish-pause.json",
    ]) {
      expect(isKeptFile(path), path).toBe(true);
    }
  });

  test("leaves out secrets, hidden folders, databases and other docs", () => {
    for (const path of [
      ".dealabs-session.json",
      ".env",
      ".home/.local/share/pki/nssdb/key4.db",
      "data/agents/app-snapshot.db",
      "data/agents/app.sqlite-wal",
      "data/agents/.cache/x.json",
      "app.db",
      "docs/architecture.md",
      "config/sub/file.json",
      "data/other/file.json",
      "src/main.server.ts",
      "data/agents/../../.env",
    ]) {
      expect(isKeptFile(path), path).toBe(false);
    }
  });
});

describe("AppFilesService", () => {
  let alepha: Alepha;
  let dir: string;
  let service: AppFilesService;
  let fx: Fixtures;

  const put = (path: string, content: string, mtime?: Date) => {
    const file = join(dir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    if (mtime) utimesSync(file, mtime, mtime);
  };
  const rows = async () =>
    Object.fromEntries(
      (await fx.files.findMany({})).map((row) => [row.id, row.content]),
    );

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "app-files-"));
    process.env.APP_FILES_DIR = dir;
    process.env.APP_FILES_SYNC = "true";
    alepha = Alepha.create({
      env: {
        ADMIN_USERNAME: "admin",
        ADMIN_PASSWORD: "s3cret-admin-pass",
        APP_SECRET: "test-app-secret-0123456789abcdef",
        DATABASE_URL: "sqlite://:memory:",
        COLLECT_ON_START: "false",
      },
    })
      .with(AlephaServer)
      .with(ApiModule)
      .with(Fixtures);
    await alepha.start();
    service = alepha.inject(AppFilesService);
    fx = alepha.inject(Fixtures);
  });

  afterAll(async () => {
    await alepha?.stop();
    delete process.env.APP_FILES_DIR;
    delete process.env.APP_FILES_SYNC;
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);
    await fx.files.clear();
    await service.sync({ restore: true });
  });

  test("saves the app's files, and only them", async () => {
    put("config/collection.json", '{"sources":{}}');
    put("data/agents/ledger.jsonl", '{"a":1}\n');
    put(".publish-pause.json", '{"paused":true}');
    put(".dealabs-session.json", "secret");
    put(".home/.local/share/pki/nssdb/key4.db", "SQLite format 3\0");
    put("data/agents/app-snapshot.db", "SQLite format 3\0");

    expect(await service.sync()).toEqual({ restored: 0, saved: 3, removed: 0 });
    expect(await rows()).toEqual({
      "config/collection.json": '{"sources":{}}',
      "data/agents/ledger.jsonl": '{"a":1}\n',
      ".publish-pause.json": '{"paused":true}',
    });
    // Nothing changed: nothing written.
    expect(await service.sync()).toEqual({ restored: 0, saved: 0, removed: 0 });
  });

  test("keeps big files byte for byte", async () => {
    const report = `${JSON.stringify({ rows: "x".repeat(200_000) })}\n\n`;
    put("data/agents/report-2026-11-01.json", report);
    await service.sync();
    expect((await rows())["data/agents/report-2026-11-01.json"]).toBe(report);
  });

  test("follows changes and deletions", async () => {
    put("config/collection.json", "{}");
    put(".publish-pause.json", "{}");
    await service.sync();

    put(
      "config/collection.json",
      '{"changed":true}',
      new Date(Date.now() + 5000),
    );
    rmSync(join(dir, ".publish-pause.json"));
    expect(await service.sync()).toEqual({ restored: 0, saved: 1, removed: 1 });
    expect(await rows()).toEqual({
      "config/collection.json": '{"changed":true}',
    });
  });

  test("writes back what a restored database holds, keeping newer files", async () => {
    const old = Date.parse("2026-10-01T10:00:00Z");
    await fx.files.create({
      id: "config/desirability.json",
      content: '{"brands":{}}',
      size: 13,
      mtimeMs: old,
    });
    await fx.files.create({
      id: "data/agents/reports/bilan-2026-10-01.md",
      content: "# Bilan",
      size: 7,
      mtimeMs: old,
    });
    await fx.files.create({
      id: "config/collection.json",
      content: "old",
      size: 3,
      mtimeMs: old,
    });
    // Not one of the app's files: never written, whatever the table says.
    await fx.files.create({
      id: ".env",
      content: "X=1",
      size: 3,
      mtimeMs: old,
    });
    put("config/collection.json", "newer on disk");

    const result = await service.sync({ restore: true });

    expect(result.restored).toBe(2);
    expect(readFileSync(join(dir, "config/desirability.json"), "utf8")).toBe(
      '{"brands":{}}',
    );
    expect(statSync(join(dir, "config/desirability.json")).mtimeMs).toBe(old);
    expect(
      readFileSync(
        join(dir, "data/agents/reports/bilan-2026-10-01.md"),
        "utf8",
      ),
    ).toBe("# Bilan");
    expect(existsSync(join(dir, ".env"))).toBe(false);
    expect((await rows())["config/collection.json"]).toBe("newer on disk");
  });

  test("a folder gone whole doesn't empty the table", async () => {
    put("config/collection.json", "{}");
    await service.sync();
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir);

    expect(await service.sync()).toEqual({ restored: 0, saved: 0, removed: 0 });
    expect(Object.keys(await rows())).toEqual(["config/collection.json"]);
  });
});
