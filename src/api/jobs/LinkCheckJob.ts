import { $inject, z } from "alepha";
import { $job } from "alepha/api/jobs";
import { $logger } from "alepha/logger";

import { CollectionService } from "../services/CollectionService.ts";

/**
 * Reads a pasted link right away (see `CollectionService.checkLink`), on
 * the jobs queue so the request that added it returns at once. Checks of
 * the same shop run one after the other.
 */
export class LinkCheckJob {
  protected log = $logger();
  protected collection = $inject(CollectionService);

  run = $job({
    name: "deals.check-link",
    description: "Reads one added link and evaluates it like a collected deal.",
    schema: z.object({ linkId: z.text() }),
    handler: async ({ payload }) => {
      const link = await this.collection.checkLink(payload.linkId);
      this.log.info(`Link ${link.id} (${link.sourceId}): ${link.status}`, {
        verdict: link.verdict,
      });
    },
  });
}
