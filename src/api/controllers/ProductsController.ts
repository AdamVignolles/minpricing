import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { trackedProductEntity } from "../entities/TrackedProduct.ts";
import { $adminSession } from "../services/AdminAuth.ts";

const trackedProductResponseSchema = trackedProductEntity.schema;

/**
 * Tracked products: the catalogue from before links (epic 16). Products
 * are now added by pasting their link (`LinksController`); at startup,
 * tracked products in a supported shop become watched links. What is left
 * here is listed in the console's « Liens ajoutés » tab, to be removed.
 *
 * Admin-only, behind {@link $adminSession}.
 */
export class ProductsController {
  protected products = $repository(trackedProductEntity);

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

  /**
   * Removes a tracked product the owner gave up on: an old manual entry
   * whose shop can't be read by link (see `SeedService.migrateTrackedProducts`).
   */
  deleteProduct = $action({
    method: "DELETE",
    path: "/products/:id",
    use: [$adminSession()],
    schema: {
      params: z.object({ id: z.text() }),
      response: z.object({ ok: z.boolean() }),
    },
    handler: async ({ params }) => {
      await this.products.deleteById(params.id);
      return { ok: true };
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
