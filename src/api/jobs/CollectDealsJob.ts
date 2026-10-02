import { $inject } from "alepha";
import { $job } from "alepha/api/jobs";
import { $logger } from "alepha/logger";

import { CollectionService } from "../services/CollectionService.ts";

/**
 * Runs the collection pipeline for every enabled source. Frequency is
 * intentionally low (every 30 min): at a few tracked products, there is no
 * need for anything more aggressive, and it stays comfortably inside
 * Cloudflare Workers' free cron/CPU budget.
 */
export class CollectDealsJob {
  protected log = $logger();
  protected collection = $inject(CollectionService);

  run = $job({
    name: "deals.collect",
    description:
      "Collects offers from every enabled source and updates deals/history/score.",
    cron: "*/30 * * * *",
    handler: async () => {
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
      }

      const failures = summaries.filter((s) => s.error).length;
      this.log.info(
        `Collection run complete: ${summaries.length} source(s), ${failures} failure(s)`,
      );
    },
  });
}
