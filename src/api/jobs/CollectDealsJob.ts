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
      this.log.info(
        `Collection run: ${summaries
          .map(
            (s) =>
              `${s.sourceId}=${s.collected}${s.error ? ` (error: ${s.error})` : ""}`,
          )
          .join(", ")}`,
      );
    },
  });
}
