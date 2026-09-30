import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action, HttpError } from "alepha/server";

import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";

const draftResponseSchema = dealabsDraftEntity.schema;

export class DraftsController {
  protected drafts = $repository(dealabsDraftEntity);

  byDeal = $action({
    method: "GET",
    path: "/deals/:id/draft",
    schema: {
      params: z.object({ id: z.text() }),
      response: draftResponseSchema.nullable(),
    },
    handler: async ({ params }) => {
      const draft = await this.drafts.findOne({
        where: { dealId: { eq: params.id } },
      });
      return draft ?? null;
    },
  });

  update = $action({
    method: "PATCH",
    path: "/deals/:id/draft",
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({
        title: z.text().optional(),
        body: z.text().optional(),
        status: z.enum(["draft", "posted", "discarded"]).optional(),
      }),
      response: draftResponseSchema,
    },
    handler: async ({ params, body }) => {
      const existing = await this.drafts.findOne({
        where: { dealId: { eq: params.id } },
      });
      if (!existing) {
        throw new HttpError({
          status: 404,
          message: `No draft for deal ${params.id}`,
        });
      }
      return this.drafts.updateById(existing.id, body);
    },
  });
}
