import { $inject } from "alepha";
import { $job } from "alepha/api/jobs";
import { $logger } from "alepha/logger";

import { CollectionService } from "../services/CollectionService.ts";

/** Hours (Paris time) of the night runs, 3 hours apart: 23h → 2h → 5h → 8h. */
const NIGHT_RUN_HOURS = [2, 5];
/** Daytime: every hour from 8:00 to 23:00. */
const DAY_START = 8;
const DAY_END = 23;

/**
 * Should a scheduled collection run at this time? Every hour during the
 * day, every 3 hours at night. Decided in Paris time on purpose: the cron
 * itself can't carry a timezone, and Cloudflare's scheduled triggers run
 * in UTC — the job fires every hour and this picks the hours, so summer
 * and winter time are both right.
 */
export function isCollectionHour(date: Date): boolean {
  // The "hour" part alone: a formatted string ("08 h") isn't a number.
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "numeric",
      hourCycle: "h23",
      timeZone: "Europe/Paris",
    })
      .formatToParts(date)
      .find((part) => part.type === "hour")?.value,
  );
  return (
    (hour >= DAY_START && hour <= DAY_END) || NIGHT_RUN_HOURS.includes(hour)
  );
}

/** Next time (on the hour) a scheduled collection will start. */
export function nextCollectionTime(from: Date): Date {
  const next = new Date(from);
  next.setUTCMinutes(0, 0, 0);
  for (let i = 0; i < 48; i++) {
    next.setUTCHours(next.getUTCHours() + 1);
    if (isCollectionHour(next)) return next;
  }
  return next;
}

/**
 * Runs the collection pipeline for every enabled source: hourly during the
 * day, every 3 hours at night (see {@link isCollectionHour}). A full run
 * takes many minutes; a tick that finds the previous run still going is
 * skipped by `CollectionService.runAll`.
 */
export class CollectDealsJob {
  protected log = $logger();
  protected collection = $inject(CollectionService);

  run = $job({
    name: "deals.collect",
    description:
      "Collects offers from every enabled source and updates deals/history/score.",
    // Fires every hour; the handler decides whether this hour collects.
    cron: "0 * * * *",
    handler: async () => {
      if (!isCollectionHour(new Date())) {
        this.log.info("Night pause: no collection this hour.");
        return;
      }
      const summaries = await this.collection.runAll();

      // One structured entry per source — rather than a single concatenated
      // string — so each source's numbers/error survive as `data` on the
      // job execution's captured logs (see `AdminController.runs`), and the
      // admin UI can show a clear per-source breakdown instead of a wall of
      // JSON.
      for (const summary of summaries) {
        if (summary.error) {
          this.log.warn(
            `${summary.sourceId}: collection failed — ${summary.error}`,
            summary,
          );
        } else {
          this.log.info(
            `${summary.sourceId}: ${summary.collected} offer(s) collected, ${summary.created} created, ${summary.updated} updated`,
            summary,
          );
        }
        // The collector's own account of the run (amazon-watch: pages,
        // robot checks, why no drop), kept in the run's log.
        for (const note of summary.notes ?? []) {
          this.log.info(`${summary.sourceId}: ${note}`);
        }
      }

      const failures = summaries.filter((s) => s.error).length;
      this.log.info(
        `Collection run complete: ${summaries.length} source(s), ${failures} failure(s)`,
      );
    },
  });
}
