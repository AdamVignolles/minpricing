import { $inject } from "alepha";
import { $cache } from "alepha/cache";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";

import {
  PUBLISH_STEPS,
  type PublishRun,
  type PublishStep,
  type PublishStepId,
  type PublishTrigger,
} from "./publishSteps.ts";

/**
 * A run silent for this long is considered dead (crash, redeploy). Longer
 * than the longest wait inside a publication: the Dealabs login window
 * stays open 10 minutes.
 */
const STALE_AFTER_MS = 15 * 60 * 1000;

export interface PublishProgress {
  /** The publication in progress, if any. */
  current?: PublishRun;
  /** The last one that finished, success or failure. */
  last?: PublishRun;
}

/**
 * Live state of the Dealabs publication in progress, step by step, for
 * the console (deal page, « Ce soir », dashboard) and the agents' MCP.
 *
 * `AutoPublishService` allows one publication at a time, so there is one
 * current run and one last run. Reporting is best-effort on purpose: no
 * method here throws, a progress write can never fail a publication.
 * Same storage choice as {@link CollectionProgressService}: the shared
 * cache, so a page polling from another worker sees the same state.
 */
export class PublishProgressService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected store = $cache<PublishRun>({
    name: "publish-progress",
    ttl: [7, "days"],
  });

  protected state?: PublishRun;

  async get(): Promise<PublishProgress> {
    const [current, last] = await Promise.all([
      this.store.get("current").catch(() => undefined),
      this.store.get("last").catch(() => undefined),
    ]);
    if (current?.status !== "running") return { last: last ?? current };
    if (Date.now() - new Date(current.updatedAt).getTime() > STALE_AFTER_MS) {
      return {
        last: {
          ...current,
          status: "failed",
          error: current.error ?? "Publication interrompue (serveur arrêté ?)",
        },
      };
    }
    return { current, last };
  }

  /** The run being reported, for saving its trail on the draft. */
  snapshot(): PublishRun | undefined {
    return this.state ? structuredClone(this.state) : undefined;
  }

  async start(input: {
    dealId: string;
    title: string;
    trigger: PublishTrigger;
  }): Promise<void> {
    const now = this.dateTime.nowISOString();
    this.state = {
      runId: `${Date.now()}`,
      dealId: input.dealId,
      title: input.title,
      trigger: input.trigger,
      status: "running",
      startedAt: now,
      updatedAt: now,
      steps: PUBLISH_STEPS.map((step) => ({ ...step, status: "pending" })),
    };
    await this.flush();
  }

  /** `id` starts; a step still running is considered done. */
  async begin(id: PublishStepId, detail?: string): Promise<void> {
    this.update((run, now) => {
      for (const step of run.steps) {
        if (step.status === "running") this.close(step, "done", now);
      }
      const step = this.find(run, id);
      if (step) {
        step.status = "running";
        step.startedAt = now;
        step.finishedAt = undefined;
        step.detail = detail;
        step.needsHuman = undefined;
      }
    });
    await this.flush();
  }

  /** `id` is done (it may not have been begun: then it took no time). */
  async done(id: PublishStepId, detail?: string): Promise<void> {
    this.update((run, now) => {
      const step = this.find(run, id);
      if (!step) return;
      step.startedAt ??= now;
      this.close(step, "done", now);
      if (detail !== undefined) step.detail = detail;
    });
    await this.flush();
  }

  /** `id` didn't apply this time (no challenge, already logged in…). */
  async skip(id: PublishStepId, detail?: string): Promise<void> {
    this.update((run, now) => {
      const step = this.find(run, id);
      if (!step) return;
      this.close(step, "skipped", now);
      step.detail = detail;
    });
    await this.flush();
  }

  /** The running step waits for someone in the « écran distant ». */
  async waitForHuman(id: PublishStepId, detail: string): Promise<void> {
    this.update((run) => {
      const step = this.find(run, id);
      if (!step) return;
      step.needsHuman = true;
      step.detail = detail;
    });
    await this.flush();
  }

  /** Marks the run alive during a long wait. */
  async touch(): Promise<void> {
    this.update(() => undefined);
    await this.flush();
  }

  /**
   * The publication failed: the running step (or the first not reached)
   * carries the reason. Steps never reached stay pending.
   */
  async fail(reason: string): Promise<void> {
    this.update((run, now) => {
      const step =
        run.steps.find((s) => s.status === "running") ??
        run.steps.find((s) => s.status === "pending");
      if (step) {
        step.startedAt ??= now;
        this.close(step, "failed", now);
        step.detail = reason.slice(0, 500);
        step.needsHuman = undefined;
      }
      run.status = "failed";
      run.error = reason.slice(0, 2000);
      run.finishedAt = now;
    });
    await this.flush(true);
  }

  /** Posted: whatever didn't run is marked skipped. */
  async finish(dealabsUrl: string): Promise<void> {
    this.update((run, now) => {
      for (const step of run.steps) {
        if (step.status === "running") this.close(step, "done", now);
        if (step.status === "pending") step.status = "skipped";
      }
      run.status = "done";
      run.dealabsUrl = dealabsUrl;
      run.finishedAt = now;
    });
    await this.flush(true);
  }

  protected find(run: PublishRun, id: PublishStepId): PublishStep | undefined {
    return run.steps.find((step) => step.id === id);
  }

  protected close(
    step: PublishStep,
    status: "done" | "skipped" | "failed",
    now: string,
  ): void {
    step.status = status;
    step.finishedAt = now;
    if (status !== "failed") step.needsHuman = undefined;
  }

  protected update(change: (run: PublishRun, now: string) => void): void {
    if (!this.state) return;
    try {
      const now = this.dateTime.nowISOString();
      change(this.state, now);
      this.state.updatedAt = now;
    } catch (error) {
      this.log.warn("Publish progress not updated", { error });
    }
  }

  /** Writes the run; a finished one also becomes « last ». */
  protected async flush(finished = false): Promise<void> {
    const run = this.state;
    if (!run) return;
    try {
      await this.store.set("current", run);
      if (finished) await this.store.set("last", run);
    } catch (error) {
      this.log.warn("Publish progress not saved", { error });
    }
  }
}
