import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * Audit trail of everything an agent changed through the agent API
 * (`AgentApiController`, `PublishScheduleController`): which file or
 * plan, why, and the before/after — so a bad change is easy to spot and
 * to roll back. Written on every accepted write, never edited.
 */
export const agentWriteEntity = $entity({
  name: "agent_writes",
  schema: z.object({
    id: db.primaryKey(),
    /** Who wrote it: the skill or routine name (`deals-weekly`…), or `admin`. */
    agent: z.text({ maxLength: 80 }),
    kind: z
      .enum(["config", "report", "proposal", "data", "schedule", "link"])
      .meta({ mode: "text" }),
    /** The file or plan written (`publish-rules`, `reports/weekly-…`). */
    target: z.text({ maxLength: 200 }),
    reason: z.text({ size: "rich" }).optional(),
    /** One line per changed value, for configs. */
    summary: z.text({ size: "rich" }).optional(),
    before: z.text({ size: "rich" }).optional(),
    after: z.text({ size: "rich" }).optional(),
    createdAt: db.createdAt(),
  }),
  indexes: [{ column: "createdAt" }, { column: "target" }],
});
