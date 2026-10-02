import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { categoryEntity } from "../entities/Category.ts";
import { merchantEntity } from "../entities/Merchant.ts";
import { $adminSession } from "../services/AdminAuth.ts";

/**
 * Read-only reference data used by the dashboard filters. Gated like every
 * other action — see `AGENTS.md`, this app has no public part.
 */
export class CatalogController {
  protected categories = $repository(categoryEntity);
  protected merchants = $repository(merchantEntity);

  listCategories = $action({
    method: "GET",
    path: "/categories",
    use: [$adminSession()],
    schema: { response: z.array(categoryEntity.schema) },
    handler: async () => this.categories.findMany(),
  });

  listMerchants = $action({
    method: "GET",
    path: "/merchants",
    use: [$adminSession()],
    schema: { response: z.array(merchantEntity.schema) },
    handler: async () => this.merchants.findMany(),
  });
}
