import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { categoryEntity } from "../entities/Category.ts";
import { merchantEntity } from "../entities/Merchant.ts";

/**
 * Read-only reference data used by the dashboard filters.
 */
export class CatalogController {
  protected categories = $repository(categoryEntity);
  protected merchants = $repository(merchantEntity);

  listCategories = $action({
    method: "GET",
    path: "/categories",
    schema: { response: z.array(categoryEntity.schema) },
    handler: async () => this.categories.findMany(),
  });

  listMerchants = $action({
    method: "GET",
    path: "/merchants",
    schema: { response: z.array(merchantEntity.schema) },
    handler: async () => this.merchants.findMany(),
  });
}
