import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";

import { writeAtomic } from "./AgentFilesService.ts";
import { appDir } from "./appDir.ts";

export interface PublishPause {
  paused: boolean;
  since?: string;
  by?: string;
  /** Resumes on its own at this time; none = until lifted by hand. */
  until?: string;
  reason?: string;
}

const PAUSE_FILE = () => join(appDir(), ".publish-pause.json");

/**
 * « Mettre en pause les publications »: while on, no scheduled slot and no
 * end-of-collection publish starts (they are skipped with « en pause »).
 * The deal page's button still publishes: a human clicked it.
 *
 * Kept in a file under `appDir()` (Bay's persistent folder), so it
 * survives a restart and a redeploy. An unreadable file reads as « not
 * paused » and is logged, never as a crash of the publishing paths.
 */
export class PublishPauseService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);

  status(): PublishPause {
    const file = PAUSE_FILE();
    if (!existsSync(file)) return { paused: false };
    try {
      const pause = JSON.parse(readFileSync(file, "utf8")) as PublishPause;
      if (
        pause.paused &&
        pause.until &&
        new Date(pause.until).getTime() <= this.now().getTime()
      ) {
        return { paused: false };
      }
      return pause;
    } catch (error) {
      this.log.warn("Publish pause file unreadable, treated as not paused", {
        error,
      });
      return { paused: false };
    }
  }

  get paused(): boolean {
    return this.status().paused;
  }

  /** The note a skipped slot or run carries while paused. */
  note(): string {
    const pause = this.status();
    if (!pause.paused) return "";
    const at = (iso: string) =>
      new Date(iso).toLocaleString("fr-FR", {
        timeZone: "Europe/Paris",
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
    return [
      "publications en pause",
      pause.since ? `depuis le ${at(pause.since)}` : "",
      pause.by ? `par ${pause.by}` : "",
      pause.until ? `jusqu'au ${at(pause.until)}` : "",
      pause.reason ? `(${pause.reason})` : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  set(input: { paused: boolean; until?: string; reason?: string }, by: string) {
    if (!input.paused) {
      rmSync(PAUSE_FILE(), { force: true });
      return { paused: false };
    }
    const pause: PublishPause = {
      paused: true,
      since: this.dateTime.nowISOString(),
      by,
      ...(input.until ? { until: input.until } : {}),
      ...(input.reason ? { reason: input.reason.slice(0, 200) } : {}),
    };
    writeAtomic(PAUSE_FILE(), JSON.stringify(pause, null, 2));
    return pause;
  }

  protected now(): Date {
    return new Date(this.dateTime.nowISOString());
  }
}
