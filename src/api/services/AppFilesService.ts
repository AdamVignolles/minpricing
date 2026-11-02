import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";

import { $hook, $inject, Alepha } from "alepha";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { appFileEntity } from "../entities/AppFile.ts";
import { appDir } from "./appDir.ts";
import {
  isKeptFile,
  KEPT_ROOTS,
  MAX_KEPT_BYTES,
  PAUSE_FILE,
} from "./appFiles.ts";

export interface AppFilesSyncResult {
  restored: number;
  saved: number;
  removed: number;
}

/**
 * Keeps the app's own files (see `appFiles.ts`) in the `app_files` table,
 * so a backup of the database is a backup of everything the app needs.
 *
 * At startup, a file missing on disk or older than its row is written
 * back (a fresh server restored from S3 gets its configs and agent files
 * again). Then, every two minutes and when the app stops, new or changed
 * files are saved and deleted ones removed. The files remain the working
 * copy: the code and the agents' scripts read and write them as before.
 *
 * Off on the serverless deployment (no file system) and in tests unless
 * `APP_FILES_SYNC=true`; `APP_FILES_SYNC=false` turns it off anywhere.
 */
export class AppFilesService {
  protected alepha = $inject(Alepha);
  protected files = $repository(appFileEntity);
  protected log = $logger();

  /** What the table holds, without the contents. */
  protected stored = new Map<string, { size: number; mtimeMs: number }>();
  /** Rows that couldn't be written back: never removed by a scan. */
  protected unwritable = new Set<string>();
  protected timer?: ReturnType<typeof setInterval>;
  protected running?: Promise<AppFilesSyncResult>;

  onReady = $hook({
    on: "ready",
    handler: async () => {
      if (!this.enabled()) return;
      try {
        const result = await this.sync({ restore: true });
        this.log.info("app files synced with the database", result);
      } catch (error) {
        this.log.error("app files: startup sync failed", error);
      }
      this.timer = setInterval(() => {
        this.sync().catch((error) =>
          this.log.warn("app files: sync failed", error),
        );
      }, 120_000);
      this.timer.unref?.();
    },
  });

  onStop = $hook({
    on: "stop",
    handler: async () => {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      if (!this.enabled()) return;
      try {
        await this.sync();
      } catch (error) {
        this.log.warn("app files: final sync failed", error);
      }
    },
  });

  enabled(): boolean {
    const flag = process.env.APP_FILES_SYNC;
    if (flag === "false") return false;
    if (this.alepha.isServerless()) return false;
    return flag === "true" || !this.alepha.isTest();
  }

  /** One sync at a time: a call during a run waits for that run. */
  sync(options: { restore?: boolean } = {}): Promise<AppFilesSyncResult> {
    this.running ??= this.run(options).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  protected async run(options: {
    restore?: boolean;
  }): Promise<AppFilesSyncResult> {
    const root = appDir();
    const result: AppFilesSyncResult = { restored: 0, saved: 0, removed: 0 };

    if (options.restore) {
      this.stored.clear();
      for (const row of await this.files.findMany({})) {
        this.stored.set(row.id, { size: row.size, mtimeMs: row.mtimeMs });
        if (!isKeptFile(row.id)) continue;
        const file = join(root, row.id);
        const disk = statOf(file);
        if (disk && disk.mtimeMs >= row.mtimeMs) continue;
        try {
          mkdirSync(dirname(file), { recursive: true });
          writeFileSync(file, row.content);
          const time = new Date(row.mtimeMs);
          utimesSync(file, time, time);
          result.restored++;
        } catch (error) {
          this.unwritable.add(row.id);
          this.log.warn(`app files: can't write back ${row.id}`, error);
        }
      }
    }

    const onDisk = listKeptFiles(root);
    for (const [path, disk] of onDisk) {
      const known = this.stored.get(path);
      if (known && known.size === disk.size && known.mtimeMs === disk.mtimeMs) {
        continue;
      }
      let content: string;
      try {
        content = readFileSync(join(root, path), "utf8");
      } catch {
        continue; // removed meanwhile: the next scan sees it gone
      }
      await this.files.upsert({ id: path, content, ...disk });
      this.stored.set(path, disk);
      result.saved++;
    }

    // A folder that vanished whole (a broken mount, a wrong APP_FILES_DIR)
    // must not empty the table: removals need at least one file left.
    if (onDisk.size > 0) {
      for (const path of this.stored.keys()) {
        if (onDisk.has(path) || this.unwritable.has(path)) continue;
        await this.files.deleteById(path);
        this.stored.delete(path);
        result.removed++;
      }
    }
    return result;
  }
}

function statOf(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return undefined;
    return { size: stat.size, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch {
    return undefined;
  }
}

function listKeptFiles(
  root: string,
): Map<string, { size: number; mtimeMs: number }> {
  const found = new Map<string, { size: number; mtimeMs: number }>();
  const add = (path: string) => {
    if (!isKeptFile(path)) return;
    const stat = statOf(join(root, path));
    if (stat && stat.size <= MAX_KEPT_BYTES) found.set(path, stat);
  };
  add(PAUSE_FILE);
  for (const dir of KEPT_ROOTS) {
    if (!existsSync(join(root, dir))) continue;
    for (const entry of readdirSync(join(root, dir), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const parent = relative(root, entry.parentPath).replace(/\\/g, "/");
      add(`${parent}/${entry.name}`);
    }
  }
  return found;
}
