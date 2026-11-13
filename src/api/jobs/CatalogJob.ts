import { $inject, Alepha } from "alepha";
import { $job } from "alepha/api/jobs";

import { CatalogService } from "../services/CatalogService.ts";

/**
 * Catalogue passes (`CatalogService`): fires every hour, the service
 * keeps the `activeHours` of `config/watch-sources.json` and reads a
 * bounded number of pages per shop, shops side by side. Local server only.
 */
export class CatalogJob {
  protected alepha = $inject(Alepha);
  protected catalog = $inject(CatalogService);

  run = $job({
    name: "catalog.read",
    description:
      "Reads the verified shop catalogues of config/watch-sources.json (every shop at its own pace, each price read again within 24 h).",
    // Every 15 min: a pass is ≤ 400 pages at ≥ 1 s each, and a shop whose
    // pass still runs is skipped — each shop keeps its own pace.
    cron: "5,20,35,50 * * * *",
    handler: async () => {
      if (this.alepha.isServerless()) return;
      await this.catalog.runDue();
    },
  });
}
