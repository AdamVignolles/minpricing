import { $inject } from "alepha";
import { $cache } from "alepha/cache";
import { DateTimeProvider } from "alepha/datetime";

export type ProgressStatus = "pending" | "running" | "done" | "failed";

export interface SourceProgress {
  id: string;
  name: string;
  status: ProgressStatus;
  /** What is happening right now, in French ("Fiches produits"). */
  step?: string;
  done?: number;
  total?: number;
  collected?: number;
  created?: number;
  updated?: number;
  error?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface ProgressEvent {
  at: string;
  sourceId?: string;
  level: "info" | "warn";
  message: string;
}

/** A collection run as the sidebar shows it. */
export interface CollectionProgress {
  runId: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Heartbeat: a "running" run not updated for minutes has died. */
  updatedAt: string;
  currentSourceId?: string;
  sources: SourceProgress[];
  /** Most recent last, capped. */
  events: ProgressEvent[];
}

/** Writes while counters move are throttled to one per second. */
const FLUSH_INTERVAL_MS = 1_000;
/** A run silent for this long is considered dead (crash, redeploy). */
const STALE_AFTER_MS = 5 * 60 * 1000;
const MAX_EVENTS = 30;

/**
 * Live state of the current (or last) collection run, for the console's
 * progress sidebar: which marketplace, which step, how far, what happened.
 *
 * Stored in the shared cache rather than in memory: on Cloudflare the run
 * executes in a queue consumer while the page polls from another isolate
 * (KV there, memory locally). No in-memory tier on purpose — a 30 s stale
 * copy would make the sidebar lag.
 */
export class CollectionProgressService {
  protected dateTime = $inject(DateTimeProvider);
  protected store = $cache<CollectionProgress>({
    name: "collection-progress",
    ttl: [12, "hours"],
  });

  protected state?: CollectionProgress;
  protected lastFlush = 0;
  protected pendingFlush?: ReturnType<typeof setTimeout>;

  async get(): Promise<CollectionProgress | undefined> {
    const stored = await this.store.get("current");
    if (
      stored?.status === "running" &&
      Date.now() - new Date(stored.updatedAt).getTime() > STALE_AFTER_MS
    ) {
      return { ...stored, status: "failed" };
    }
    return stored;
  }

  /** Is a run in progress right now (anywhere)? */
  async isRunning(): Promise<boolean> {
    return (await this.get())?.status === "running";
  }

  async start(sources: Array<{ id: string; name: string }>): Promise<void> {
    const now = this.dateTime.nowISOString();
    this.state = {
      runId: `${Date.now()}`,
      status: "running",
      startedAt: now,
      updatedAt: now,
      sources: sources.map((source) => ({ ...source, status: "pending" })),
      events: [],
    };
    this.event(`Collecte lancée sur ${sources.length} source(s).`);
    await this.flush();
  }

  async sourceStarted(sourceId: string): Promise<void> {
    this.patch(sourceId, {
      status: "running",
      step: "Démarrage",
      startedAt: this.dateTime.nowISOString(),
    });
    if (this.state) this.state.currentSourceId = sourceId;
    await this.flush();
  }

  /** Progress inside a source; cheap to call often (throttled). */
  step(sourceId: string, step: string, done?: number, total?: number): void {
    const previous = this.state?.sources.find((s) => s.id === sourceId)?.step;
    this.patch(sourceId, { step, done, total });
    if (previous !== step) {
      this.event(step, sourceId);
    }
    this.scheduleFlush();
  }

  async sourceFinished(
    sourceId: string,
    summary: {
      collected: number;
      created: number;
      updated: number;
      error?: string;
    },
  ): Promise<void> {
    this.patch(sourceId, {
      status: summary.error ? "failed" : "done",
      step: undefined,
      done: undefined,
      total: undefined,
      collected: summary.collected,
      created: summary.created,
      updated: summary.updated,
      error: summary.error,
      finishedAt: this.dateTime.nowISOString(),
    });
    this.event(
      summary.error
        ? `Échec : ${summary.error}`
        : `${summary.collected} offre(s) : ${summary.created} nouvelle(s), ${summary.updated} mise(s) à jour.`,
      sourceId,
      summary.error ? "warn" : "info",
    );
    await this.flush();
  }

  async finish(failed = false): Promise<void> {
    if (!this.state) return;
    this.state.status = failed ? "failed" : "done";
    this.state.finishedAt = this.dateTime.nowISOString();
    this.state.currentSourceId = undefined;
    this.event(failed ? "Collecte interrompue." : "Collecte terminée.");
    await this.flush();
  }

  protected patch(sourceId: string, values: Partial<SourceProgress>): void {
    const source = this.state?.sources.find((s) => s.id === sourceId);
    if (source) Object.assign(source, values);
  }

  protected event(
    message: string,
    sourceId?: string,
    level: ProgressEvent["level"] = "info",
  ): void {
    if (!this.state) return;
    this.state.events.push({
      at: this.dateTime.nowISOString(),
      sourceId,
      level,
      message,
    });
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    }
  }

  protected scheduleFlush(): void {
    const wait = FLUSH_INTERVAL_MS - (Date.now() - this.lastFlush);
    if (wait <= 0) {
      void this.flush();
    } else if (!this.pendingFlush) {
      this.pendingFlush = setTimeout(() => void this.flush(), wait);
    }
  }

  protected async flush(): Promise<void> {
    if (this.pendingFlush) {
      clearTimeout(this.pendingFlush);
      this.pendingFlush = undefined;
    }
    if (!this.state) return;
    this.lastFlush = Date.now();
    this.state.updatedAt = this.dateTime.nowISOString();
    // Progress is a nicety: a cache hiccup must never break the run.
    await this.store
      .set("current", structuredClone(this.state))
      .catch(() => undefined);
  }
}
