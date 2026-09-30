import { $module } from "alepha";

import { AdminController } from "./controllers/AdminController.ts";
import { CatalogController } from "./controllers/CatalogController.ts";
import { DealsController } from "./controllers/DealsController.ts";
import { DraftsController } from "./controllers/DraftsController.ts";
import { ProductsController } from "./controllers/ProductsController.ts";
import { SourcesController } from "./controllers/SourcesController.ts";
import { CollectDealsJob } from "./jobs/CollectDealsJob.ts";
import { CollectionService } from "./services/CollectionService.ts";
import { DealabsDraftService } from "./services/DealabsDraftService.ts";
import { PricingService } from "./services/PricingService.ts";
import { ScoringService } from "./services/ScoringService.ts";
import { SeedService } from "./services/SeedService.ts";

export const ApiModule = $module({
  name: "minpricing.api",
  services: [
    // controllers
    DealsController,
    CatalogController,
    SourcesController,
    ProductsController,
    DraftsController,
    AdminController,
    // jobs
    CollectDealsJob,
    // services
    CollectionService,
    PricingService,
    ScoringService,
    DealabsDraftService,
    SeedService,
  ],
});
