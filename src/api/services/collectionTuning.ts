import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * `config/collection.json`: how much the Amazon and Cdiscount collectors
 * read, re-read before each run so the local agents can steer the
 * collection toward what gets published (PC, tech…) without a restart.
 */
export interface ShopTuning {
  limit?: number;
  bounds?: [number, number];
  extraPages?: Record<string, { url: string; enabled: boolean }>;
}

/** Per-source schedule, steered by the `deals-sources` agent. */
export interface SourceTuning {
  /** `false` skips the source in scheduled runs (code and data stay). */
  enabled?: boolean;
  /** Run at most once every N hours (the hourly job skips it meanwhile). */
  everyHours?: number;
}

export interface CollectionTuning {
  amazon?: ShopTuning;
  cdiscount?: ShopTuning;
  sources?: Record<string, SourceTuning>;
  /** Sources Adam wants kept: never skipped as disabled. */
  lockedSources?: string[];
}

/** `everyHours` is clamped here: past 24 h a source's deals would expire. */
export const SOURCE_EVERY_HOURS_BOUNDS: [number, number] = [1, 24];

/**
 * Whether a scheduled run should collect this source now: not switched
 * off (unless locked), and its last success older than `everyHours`
 * (10 min of slack so an hourly job doesn't miss a slot by seconds).
 */
export function sourceDue(
  sourceId: string,
  lastSuccessAt: string | undefined,
  now: number,
  tuning: CollectionTuning,
): { due: boolean; reason?: "disabled" | "not-yet" } {
  const entry = tuning.sources?.[sourceId];
  if (entry?.enabled === false && !tuning.lockedSources?.includes(sourceId)) {
    return { due: false, reason: "disabled" };
  }
  if (!entry?.everyHours || !lastSuccessAt) return { due: true };
  const [min, max] = SOURCE_EVERY_HOURS_BOUNDS;
  const hours = Math.min(Math.max(entry.everyHours, min), max);
  const elapsed = now - new Date(lastSuccessAt).getTime();
  return elapsed >= hours * 3_600_000 - 10 * 60_000
    ? { due: true }
    : { due: false, reason: "not-yet" };
}

export function loadCollectionTuning(
  file = join(process.cwd(), "config", "collection.json"),
): CollectionTuning {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // No file (Workers, fresh clone): the env defaults alone.
    return {};
  }
}

/**
 * The pages and cap for one shop: the env/default pages plus the enabled
 * extra pages (no duplicates), and the tuned limit clamped to its bounds.
 */
export function resolveTargets(
  baseUrls: string[],
  baseLimit: number,
  tuning: ShopTuning | undefined,
): { urls: string[]; limit: number } {
  const extra = Object.values(tuning?.extraPages ?? {})
    .filter((page) => page.enabled && page.url)
    .map((page) => page.url);
  const urls = [...new Set([...baseUrls, ...extra])];
  let limit = tuning?.limit ?? baseLimit;
  if (tuning?.bounds) {
    limit = Math.min(Math.max(limit, tuning.bounds[0]), tuning.bounds[1]);
  }
  return { urls, limit };
}

/** One source's line in `data/agents/collection-runs.jsonl`. */
export interface LoggedSourceRun {
  at: string;
  ms?: number;
  collected?: number;
  createdVisible?: number;
  error?: string;
}

/**
 * Each source's latest entry in the run log written by
 * `CollectionService.logRun` (only the file's tail is read: it grows by
 * one line per run). Empty when there is no log (Workers, fresh clone).
 */
export function lastLoggedRuns(
  file = join(process.cwd(), "data", "agents", "collection-runs.jsonl"),
  tailBytes = 256 * 1024,
): Map<string, LoggedSourceRun> {
  const runs = new Map<string, LoggedSourceRun>();
  try {
    const size = statSync(file).size;
    const length = Math.min(size, tailBytes);
    const buffer = Buffer.alloc(length);
    const fd = openSync(file, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    for (const line of buffer.toString("utf8").split("\n")) {
      try {
        const run = JSON.parse(line) as {
          at: string;
          sources: Array<LoggedSourceRun & { id: string }>;
        };
        for (const { id, ...source } of run.sources ?? []) {
          runs.set(id, { ...source, at: run.at });
        }
      } catch {
        // First (cut) line of the tail, or a blank one.
      }
    }
  } catch {
    // No log yet.
  }
  return runs;
}
