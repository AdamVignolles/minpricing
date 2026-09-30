import { z } from "alepha";
import { $entity, db } from "alepha/orm";

/**
 * A generated draft for a Dealabs post. Never posted automatically:
 * you review/edit it here, then copy it to Dealabs yourself.
 */
export const dealabsDraftEntity = $entity({
  name: "dealabs_drafts",
  schema: z.object({
    id: db.primaryKey(),
    dealId: z.text(),
    title: z.text({ minLength: 1, maxLength: 300 }),
    body: z.text(),
    status: db.default(
      z.enum(["draft", "posted", "discarded"]).meta({ mode: "text" }),
      "draft",
    ),
    generatedAt: z.datetime(),
    createdAt: db.createdAt(),
    updatedAt: db.updatedAt(),
  }),
  indexes: [{ column: "dealId", unique: true }, { column: "status" }],
});
