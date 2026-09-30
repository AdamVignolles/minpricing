import { z } from "alepha";
import { $page } from "alepha/react/router";
import { $client } from "alepha/server/links";

import type { AdminController } from "../api/controllers/AdminController.ts";
import type { CatalogController } from "../api/controllers/CatalogController.ts";
import type { DealsController } from "../api/controllers/DealsController.ts";
import type { DraftsController } from "../api/controllers/DraftsController.ts";
import type { ProductsController } from "../api/controllers/ProductsController.ts";
import type { SourcesController } from "../api/controllers/SourcesController.ts";

const dealListQuerySchema = z.object({
  status: z.enum(["active", "expired", "archived"]).optional(),
  minScore: z.number().min(0).max(100).optional(),
  categoryId: z.text().optional(),
  merchantId: z.text().optional(),
  sourceId: z.text().optional(),
  search: z.text().optional(),
  sort: z.text().optional(),
  page: z.number().optional(),
});

export class AppRouter {
  deals = $client<DealsController>();
  catalog = $client<CatalogController>();
  sources = $client<SourcesController>();
  products = $client<ProductsController>();
  drafts = $client<DraftsController>();
  admin = $client<AdminController>();

  home = $page({
    path: "/",
    name: "home",
    schema: { query: dealListQuerySchema },
    lazy: () => import("./components/DealListPage.tsx"),
    loader: async ({ query }) => {
      const [dealsPage, categories, merchants, sources] = await Promise.all([
        this.deals.list({ query: { size: 20, ...query } }),
        this.catalog.listCategories({}),
        this.catalog.listMerchants({}),
        this.sources.listSources({}),
      ]);
      return { dealsPage, categories, merchants, sources, query };
    },
  });

  dealDetail = $page({
    path: "/deals/:id",
    name: "deal-detail",
    schema: { params: z.object({ id: z.text() }) },
    lazy: () => import("./components/DealDetailPage.tsx"),
    loader: async ({ params }) => {
      const [deal, history, draft] = await Promise.all([
        this.deals.detail({ params: { id: params.id } }),
        this.deals.historyOf({ params: { id: params.id } }),
        this.drafts.byDeal({ params: { id: params.id } }),
      ]);
      return { deal, history, draft };
    },
  });

  adminPage = $page({
    path: "/admin",
    name: "admin",
    lazy: () => import("./components/AdminPage.tsx"),
    loader: async () => {
      const [stats, products] = await Promise.all([
        this.admin.stats({}),
        this.products.listProducts({ query: {} }),
      ]);
      return { stats, products };
    },
  });
}
