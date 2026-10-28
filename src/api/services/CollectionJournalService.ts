import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { collectionRunEntity } from "../entities/CollectionRun.ts";

export type RunStatus =
  | "running"
  | "ok"
  | "partial"
  | "failed"
  | "skipped"
  | "cancelled";

export interface RunSourceResult {
  id: string;
  ms?: number;
  collected: number;
  created: number;
  createdVisible?: number;
  updated: number;
  rejected?: number;
  error?: string;
  lightpandaFallbacks?: number;
}

/** Rows older than this are pruned so the table stays small. */
const KEEP_MS = 90 * 24 * 60 * 60 * 1000;

/** ok / partial / failed from the per-source results of a finished run. */
export function runStatusOf(results: RunSourceResult[]): RunStatus {
  const failed = results.filter((r) => r.error).length;
  if (failed === 0) return "ok";
  return failed === results.length ? "failed" : "partial";
}

/**
 * The collection journal. Every method logs its own failure loudly and
 * returns: a broken journal must never break a run, but never be silent.
 */
export class CollectionJournalService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected runs = $repository(collectionRunEntity);

  async open(trigger: "schedule" | "manual"): Promise<string | undefined> {
    try {
      const row = await this.runs.create({
        trigger,
        status: "running",
        startedAt: this.dateTime.nowISOString(),
      });
      return row.id;
    } catch (error) {
      this.log.error("Collection journal: could not open the run row", error);
      return undefined;
    }
  }

  async close(
    id: string | undefined,
    values: {
      status: RunStatus;
      results?: RunSourceResult[];
      switchedOff?: string[];
      error?: string;
    },
  ): Promise<void> {
    if (!id) return;
    try {
      await this.runs.updateById(id, {
        status: values.status,
        endedAt: this.dateTime.nowISOString(),
        results: values.results ? JSON.stringify(values.results) : undefined,
        switchedOff: values.switchedOff?.length
          ? JSON.stringify(values.switchedOff)
          : undefined,
        error: values.error?.slice(0, 4000),
      });
    } catch (error) {
      this.log.error("Collection journal: could not close the run row", error);
    }
  }

  async recordSkipped(
    trigger: "schedule" | "manual",
    reason: string,
  ): Promise<void> {
    try {
      const now = this.dateTime.nowISOString();
      await this.runs.create({
        trigger,
        status: "skipped",
        skipReason: reason,
        startedAt: now,
        endedAt: now,
      });
    } catch (error) {
      this.log.error("Collection journal: could not record a skip", error);
    }
  }

  /**
   * Rows still "running" when nothing is running (restart, crash) are
   * closed as failed; old rows are pruned. Call it before a run starts.
   */
  async tidy(): Promise<void> {
    try {
      const stale = await this.runs.findMany({
        where: { status: { eq: "running" } },
      });
      for (const row of stale) {
        await this.runs.updateById(row.id, {
          status: "failed",
          endedAt: this.dateTime.nowISOString(),
          error: "Interrompue (redémarrage ou arrêt brutal du serveur).",
        });
      }
      const limit = new Date(Date.now() - KEEP_MS).toISOString();
      await this.runs.deleteMany({ startedAt: { lt: limit } });
    } catch (error) {
      this.log.error("Collection journal: tidy failed", error);
    }
  }
}
