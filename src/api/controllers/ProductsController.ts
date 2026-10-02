import { z } from "alepha";
import { $inject } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import { $adminSession } from "../services/AdminAuth.ts";
import { CollectionService } from "../services/CollectionService.ts";

const trackedProductResponseSchema = trackedProductEntity.schema;

/**
 * Manage the catalog of products you watch. Adding a product does not
 * collect it immediately for "manual" sources (there is no price yet, see
 * `updateManualPrice`); for "api" sources (Steam) it is picked up on the
 * next cron run, or immediately via `POST /api/admin/collect`.
 *
 * Admin-only: every action here is only ever called from the `/admin`
 * dashboard, so all three sit behind the same {@link $adminSession} gate.
 */
export class ProductsController {
  protected products = $repository(trackedProductEntity);
  protected collection = $inject(CollectionService);

  listProducts = $action({
    method: "GET",
    path: "/products",
    use: [$adminSession()],
    schema: {
      query: z.object({ sourceId: z.text().optional() }),
      response: z.array(trackedProductResponseSchema),
    },
    handler: async ({ query }) =>
      this.products.findMany({
        where: query.sourceId ? { sourceId: { eq: query.sourceId } } : {},
      }),
  });

  create = $action({
    method: "POST",
    path: "/products",
    use: [$adminSession()],
    schema: {
      body: z.object({
        sourceId: z.text(),
        title: z.text({ minLength: 1, maxLength: 300 }),
        url: z.text(),
        merchantId: z.text().optional(),
        categoryId: z.text().optional(),
        steamAppId: z.number().optional(),
        manualPrice: z.number().min(0).optional(),
        idealoUrl: z.text().optional(),
        currency: z.text().optional(),
      }),
      response: trackedProductResponseSchema,
    },
    handler: async ({ body }) =>
      this.products.create({
        ...body,
        currency: body.currency ?? "EUR",
      }),
  });

  /**
   * Records the price you just observed on Amazon/Cdiscount, then
   * immediately re-runs the "manual" collector so the deal/history/score
   * reflect it without waiting for the next cron tick.
   */
  updateManualPrice = $action({
    method: "PATCH",
    path: "/products/:id/price",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({ manualPrice: z.number().min(0) }),
      response: trackedProductResponseSchema,
    },
    handler: async ({ params, body }) => {
      const product = await this.products.updateById(params.id, {
        manualPrice: body.manualPrice,
      });
      await this.collection.runOne(product.sourceId);
      return product;
    },
  });

  /**
   * Sets/clears the Idealo.fr product page used as an external market
   * reference price for scoring (see `IdealoReferenceService`). Doesn't
   * re-run collection itself: the reference price is only (re)fetched
   * lazily, on the next collection run for this product's source.
   */
  updateIdealoUrl = $action({
    method: "PATCH",
    path: "/products/:id/idealo",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({ idealoUrl: z.text().optional() }),
      response: trackedProductResponseSchema,
    },
    handler: async ({ params, body }) =>
      this.products.updateById(params.id, {
        idealoUrl: body.idealoUrl,
        // Clearing the URL, or pointing it at a different page, voids any
        // cached price: it belonged to whatever page was set before.
        idealoReferencePrice: undefined,
        idealoCheckedAt: undefined,
      }),
  });
}
