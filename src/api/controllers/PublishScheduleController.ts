import { $inject, Alepha, z } from "alepha";
import { $action } from "alepha/server";

import { publishScheduleEntity } from "../entities/PublishSchedule.ts";
import { $adminSession, $agentAuth } from "../services/AdminAuth.ts";
import { PublishScheduleService } from "../services/PublishScheduleService.ts";

const day = z.text({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const listResponse = z.object({
  date: z.text(),
  entries: z.array(publishScheduleEntity.schema),
  queue: z.array(z.record(z.text(), z.any())),
  /** Automatic publishing paused by hand: due slots are skipped. */
  pause: z.object({
    paused: z.boolean(),
    since: z.text().optional(),
    by: z.text().optional(),
    until: z.text().optional(),
    reason: z.text().optional(),
  }),
});

/**
 * Tonight's publishing plan (`PublishScheduleService`): set by an agent
 * (`PUT /agent/schedule`, agent token or admin), shown and edited in the
 * console's Agents page. Running the entries is `PublishScheduleJob`'s job.
 */
export class PublishScheduleController {
  protected alepha = $inject(Alepha);
  protected service = $inject(PublishScheduleService);

  protected caller(fallback: string): string {
    const request = this.alepha.store.get("alepha.http.request");
    return request?.metadata?.agentCaller === "agent" ? fallback : "admin";
  }

  agentSchedulePut = $action({
    method: "PUT",
    path: "/agent/schedule",
    use: [$agentAuth()],
    schema: {
      body: z.object({
        ranked: z
          .array(z.object({ dealId: z.text() }).catchall(z.any()))
          .min(1)
          .max(30),
        times: z
          .array(z.text({ maxLength: 5 }))
          .max(10)
          .optional(),
        now: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        agent: z.text({ minLength: 1, maxLength: 80 }),
        reason: z.text({ size: "rich" }).optional(),
      }),
      response: z.object({
        date: z.text(),
        entries: z.array(publishScheduleEntity.schema),
        ranked: z.number(),
        dropped: z.array(z.text()),
      }),
    },
    handler: async ({ body }) => {
      const request = this.alepha.store.get("alepha.http.request");
      const agent =
        request?.metadata?.agentCaller === "admin"
          ? `admin (${body.agent})`
          : body.agent;
      return this.service.plan({ ...body, agent });
    },
  });

  agentScheduleGet = $action({
    method: "GET",
    path: "/agent/schedule",
    use: [$agentAuth()],
    schema: {
      query: z.object({ date: day.optional() }),
      response: listResponse,
    },
    handler: ({ query }) => this.service.list(query.date),
  });

  publishPlan = $action({
    method: "GET",
    path: "/schedule",
    use: [$adminSession()],
    schema: {
      query: z.object({ date: day.optional() }),
      response: listResponse,
    },
    handler: ({ query }) => this.service.list(query.date),
  });

  cancelEntry = $action({
    method: "POST",
    path: "/agent/schedule/:id/cancel",
    use: [$agentAuth()],
    schema: {
      params: z.object({ id: z.text() }),
      response: publishScheduleEntity.schema,
    },
    handler: ({ params }) =>
      this.service.cancel(params.id, this.caller("agent")),
  });

  moveEntry = $action({
    method: "PATCH",
    path: "/agent/schedule/:id",
    use: [$agentAuth()],
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({ time: z.text({ maxLength: 5 }) }),
      response: publishScheduleEntity.schema,
    },
    handler: ({ params, body }) =>
      this.service.reschedule(params.id, body.time, this.caller("agent")),
  });
}
