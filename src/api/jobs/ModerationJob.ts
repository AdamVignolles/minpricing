import { $inject, Alepha } from "alepha";
import { $job } from "alepha/api/jobs";
import { $logger } from "alepha/logger";

import { DealabsModerationService } from "../services/DealabsModerationService.ts";

/**
 * Reads what Dealabs' moderators did with our recent posts (see
 * `DealabsModerationService`): every 20 minutes, since a hidden post is
 * deleted when nobody acts within 3–4 hours. Reads only, never replies.
 */
export class ModerationJob {
  protected log = $logger();
  protected alepha = $inject(Alepha);
  protected moderation = $inject(DealabsModerationService);

  run = $job({
    name: "deals.dealabs-moderation",
    description:
      "Reads Dealabs' moderation of our recent posts (thread status, moderators' messages).",
    cron: "7,27,47 * * * *",
    handler: async () => {
      if (this.alepha.isServerless()) return;
      const pass = await this.moderation.poll();
      if (pass.changed.length || pass.messagesSkipped) {
        this.log.info("Dealabs moderation pass", pass);
      }
    },
  });
}
