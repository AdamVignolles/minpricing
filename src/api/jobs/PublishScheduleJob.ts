import { $inject } from "alepha";
import { $job } from "alepha/api/jobs";
import { $logger } from "alepha/logger";

import { PublishScheduleService } from "../services/PublishScheduleService.ts";

/**
 * Runs the publishing plan's due entries (see `PublishScheduleService`).
 * Every 5 minutes, so a planned time is honoured within 5 minutes.
 */
export class PublishScheduleJob {
  protected log = $logger();
  protected schedule = $inject(PublishScheduleService);

  run = $job({
    name: "deals.publish-schedule",
    description: "Publishes tonight's planned deals when their time comes.",
    cron: "*/5 * * * *",
    handler: async () => {
      for (const entry of await this.schedule.runDue()) {
        this.log.info(
          `Publishing plan ${entry.plannedAt}: ${entry.status}${entry.result ? ` (${entry.result})` : ""}`,
          entry,
        );
      }
    },
  });
}
