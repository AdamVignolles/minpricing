import { z } from "alepha";
import { $inject } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { sourceEntity } from "../entities/Source.ts";
import { CollectionService } from "../services/CollectionService.ts";

export class AdminController {
  protected deals = $repository(dealEntity);
  protected sources = $repository(sourceEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected collection = $inject(CollectionService);

  stats = $action({
    method: "GET",
    path: "/admin/stats",
    schema: {
      response: z.object({
        activeDeals: z.number(),
        expiredDeals: z.number(),
        draftsPending: z.number(),
        sources: z.array(
          z.object({
            id: z.text(),
            name: z.text(),
            enabled: z.boolean(),
            lastRunAt: z.datetime().optional(),
            lastSuccessAt: z.datetime().optional(),
            lastErrorAt: z.datetime().optional(),
            lastError: z.text().optional(),
          }),
        ),
      }),
    },
    handler: async () => {
      const [activeDeals, expiredDeals, draftsPending, sources] =
        await Promise.all([
          this.deals.count({ status: { eq: "active" } }),
          this.deals.count({ status: { eq: "expired" } }),
          this.drafts.count({ status: { eq: "draft" } }),
          this.sources.findMany(),
        ]);

      return { activeDeals, expiredDeals, draftsPending, sources };
    },
  });

  /**
   * Runs the collection pipeline right now, for every enabled source, so
   * you don't have to wait for the next cron tick when testing/demoing.
   */
  collectNow = $action({
    method: "POST",
    path: "/admin/collect",
    schema: {
      response: z.array(
        z.object({
          sourceId: z.text(),
          collected: z.number(),
          created: z.number(),
          updated: z.number(),
          error: z.text().optional(),
        }),
      ),
    },
    handler: async () => this.collection.runAll(),
  });
}
