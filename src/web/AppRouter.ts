import { z } from "alepha";
import { $head } from "alepha/react/head";
import { $page, Redirection } from "alepha/react/router";
import { HttpError } from "alepha/server";
import { $client } from "alepha/server/links";

import type { AdminController } from "../api/controllers/AdminController.ts";
import type { AuthController } from "../api/controllers/AuthController.ts";
import type { CatalogController } from "../api/controllers/CatalogController.ts";
import type { DealsController } from "../api/controllers/DealsController.ts";
import type { DraftsController } from "../api/controllers/DraftsController.ts";
import type { ProductsController } from "../api/controllers/ProductsController.ts";
import type { SourcesController } from "../api/controllers/SourcesController.ts";
import type { StatsController } from "../api/controllers/StatsController.ts";

const dealListQuerySchema = z.object({
  search: z.text().optional(),
  sortBy: z
    .enum(["relevance", "discount", "price-asc", "price-desc", "newest"])
    .optional(),
  categoryId: z.text().optional(),
  merchantId: z.text().optional(),
  sourceId: z.text().optional(),
  minDiscount: z.number().min(0).max(100).optional(),
  minPrice: z.number().min(0).optional(),
  maxPrice: z.number().min(0).optional(),
  page: z.number().optional(),
});

/**
 * Applies the stored colour scheme before React hydrates.
 *
 * Without it the server markup is always dark and a user who chose light
 * sees a flash on every navigation. Copied from Mantine's
 * `ColorSchemeScript`, which cannot be mounted directly because Alepha owns
 * the document shell.
 */
const COLOR_SCHEME_SCRIPT = `try {
  var stored = window.localStorage.getItem("mantine-color-scheme-value");
  var scheme = stored === "light" || stored === "dark" || stored === "auto" ? stored : "dark";
  var computed = scheme !== "auto" ? scheme : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.setAttribute("data-mantine-color-scheme", computed);
} catch (e) {}`;

export class AppRouter {
  deals = $client<DealsController>();
  catalog = $client<CatalogController>();
  sources = $client<SourcesController>();
  products = $client<ProductsController>();
  drafts = $client<DraftsController>();
  admin = $client<AdminController>();
  stats = $client<StatsController>();
  auth = $client<AuthController>();

  head = $head({
    title: "DealRadar",
    titleSeparator: " · ",
    description:
      "Suivi automatisé des bons plans : réduction réelle, historique de prix et brouillons Dealabs.",
    // Matches `defaultColorScheme="dark"` in the layout, so the first paint
    // is already dark instead of flashing white.
    htmlAttributes: { "data-mantine-color-scheme": "dark", lang: "fr" },
    script: [{ content: COLOR_SCHEME_SCRIPT }],
  });

  /**
   * Layout route. It owns `MantineProvider`, the shell and the navigation;
   * every other page is a child and renders through its `NestedView`.
   *
   * The parent/child edge is declared here only — Alepha warns that
   * declaring it on both sides registers the route twice.
   */
  layout = $page({
    name: "layout",
    lazy: () => import("./components/layout/AppLayout.tsx"),
    children: () => [
      this.home,
      this.dealsList,
      this.dealDetail,
      this.statsPage,
      this.adminPage,
    ],
    // This app has no public part (see `AGENTS.md`): every action behind
    // every page's loader is gated by `$adminSession()`, so an anonymous
    // visitor hitting ANY page gets a 401 from the loader. Declaring the
    // redirect once here, on the parent, covers every child page below —
    // a leaf page without its own `errorHandler` lets the error bubble up.
    errorHandler: (error) => {
      if (HttpError.is(error, 401)) {
        return new Redirection("/login");
      }
    },
  });

  /**
   * Not gated — this is how the signed session cookie is obtained in the
   * first place. `loginPage` itself has no loader (nothing to fetch before
   * the user is authenticated), so it never triggers the 401 redirect.
   */
  loginPage = $page({
    path: "/login",
    name: "login",
    lazy: () => import("./pages/LoginPage.tsx"),
  });

  home = $page({
    path: "/",
    name: "home",
    lazy: () => import("./pages/DashboardPage.tsx"),
    loader: async () => {
      const [overview, highlights, merchants] = await Promise.all([
        this.stats.overview({}),
        this.deals.highlights({ query: { size: 8 } }),
        this.catalog.listMerchants({}),
      ]);
      return { overview, highlights, merchants };
    },
  });

  dealsList = $page({
    path: "/deals",
    name: "deals",
    schema: { query: dealListQuerySchema },
    lazy: () => import("./pages/DealsListPage.tsx"),
    loader: async ({ query }) => {
      const [dealsPage, categories, merchants, sources] = await Promise.all([
        this.deals.list({ query: { size: 24, status: "active", ...query } }),
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
    lazy: () => import("./pages/DealDetailPage.tsx"),
    loader: async ({ params }) => {
      const deal = await this.deals.detail({ params: { id: params.id } });
      // Fetched after the deal so a missing id fails fast instead of firing
      // five requests for something that does not exist.
      const [history, stats, draft, merchants, categories] = await Promise.all([
        this.deals.historyOf({ params: { id: params.id } }),
        this.deals.priceStats({ params: { id: params.id } }),
        this.drafts.byDeal({ params: { id: params.id } }),
        this.catalog.listMerchants({}),
        this.catalog.listCategories({}),
      ]);
      return { deal, history, stats, draft, merchants, categories };
    },
  });

  statsPage = $page({
    path: "/stats",
    name: "stats",
    lazy: () => import("./pages/StatsPage.tsx"),
    loader: async () => ({ overview: await this.stats.overview({}) }),
  });

  adminPage = $page({
    path: "/admin",
    name: "admin",
    lazy: () => import("./pages/AdminPage.tsx"),
    loader: async () => {
      const [stats, products, runs, sources] = await Promise.all([
        this.admin.stats({}),
        this.products.listProducts({ query: {} }),
        this.admin.runs({ query: { size: 20 } }),
        this.sources.listSources({}),
      ]);
      return { stats, products, runs, sources };
    },
  });
}
