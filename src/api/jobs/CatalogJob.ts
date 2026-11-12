import { $inject, Alepha } from "alepha";
import { $job } from "alepha/api/jobs";

import { CatalogService } from "../services/CatalogService.ts";

/**
 * Catalogue passes (`CatalogService`): fires every hour, the service
 * keeps the night hours of `config/watch-sources.json` and reads a
 * bounded number of pages per shop. Local server only.
 */
export class CatalogJob {
  protected alepha = $inject(Alepha);
  protected catalog = $inject(CatalogService);

  run = $job({
    name: "catalog.read",
    description:
      "Reads the verified shop catalogues of config/watch-sources.json (night hours, paced).",
    cron: "35 * * * *",
    handler: async () => {
      if (this.alepha.isServerless()) return;
      await this.catalog.runDue();
    },
  });
}
