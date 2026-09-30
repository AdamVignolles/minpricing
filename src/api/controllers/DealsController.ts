import { z } from "alepha";
import { $repository, db, pageQuerySchema } from "alepha/orm";
import { $action } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";

const dealResponseSchema = dealEntity.schema;

export class DealsController {
  protected deals = $repository(dealEntity);
  protected history = $repository(priceHistoryEntity);

  list = $action({
    method: "GET",
    path: "/deals",
    schema: {
      query: pageQuerySchema.extend({
        status: z.enum(["active", "expired", "archived"]).optional(),
        minScore: z.number().min(0).max(100).optional(),
        categoryId: z.text().optional(),
        merchantId: z.text().optional(),
        sourceId: z.text().optional(),
        search: z.text().optional(),
      }),
      response: db.page(dealResponseSchema),
    },
    handler: async ({ query }) => {
      const {
        page = 0,
        size = 10,
        sort,
        status,
        minScore,
        categoryId,
        merchantId,
        sourceId,
        search,
      } = query;

      const conditions: Record<string, unknown>[] = [];
      if (status) conditions.push({ status: { eq: status } });
      if (minScore !== undefined) conditions.push({ score: { gte: minScore } });
      if (categoryId) conditions.push({ categoryId: { eq: categoryId } });
      if (merchantId) conditions.push({ merchantId: { eq: merchantId } });
      if (sourceId) conditions.push({ sourceId: { eq: sourceId } });
      if (search) conditions.push({ title: { ilike: `%${search}%` } });

      const where = conditions.length > 0 ? { and: conditions } : {};

      return this.deals.paginate(
        { page, size, sort: sort ?? "-score" },
        { where },
        { count: true },
      );
    },
  });

  detail = $action({
    method: "GET",
    path: "/deals/:id",
    schema: {
      params: z.object({ id: z.text() }),
      response: dealResponseSchema,
    },
    handler: async ({ params }) => this.deals.getById(params.id),
  });

  historyOf = $action({
    method: "GET",
    path: "/deals/:id/history",
    schema: {
      params: z.object({ id: z.text() }),
      response: z.array(priceHistoryEntity.schema),
    },
    handler: async ({ params }) =>
      this.history.findMany({
        where: { dealId: { eq: params.id } },
        orderBy: { column: "observedAt", direction: "asc" },
      }),
  });
}
