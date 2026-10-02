import { $module } from "alepha";

import { AdminController } from "./controllers/AdminController.ts";
import { AuthController } from "./controllers/AuthController.ts";
import { CatalogController } from "./controllers/CatalogController.ts";
import { DealsController } from "./controllers/DealsController.ts";
import { DraftsController } from "./controllers/DraftsController.ts";
import { ProductsController } from "./controllers/ProductsController.ts";
import { SourcesController } from "./controllers/SourcesController.ts";
import { StatsController } from "./controllers/StatsController.ts";
import { CollectDealsJob } from "./jobs/CollectDealsJob.ts";
import { CategorizationService } from "./services/CategorizationService.ts";
import { CollectionService } from "./services/CollectionService.ts";
import { DealabsDraftService } from "./services/DealabsDraftService.ts";
import { IdealoReferenceService } from "./services/IdealoReferenceService.ts";
import { PricingService } from "./services/PricingService.ts";
import { ScoringService } from "./services/ScoringService.ts";
import { SeedService } from "./services/SeedService.ts";

export const ApiModule = $module({
  name: "minpricing.api",
  services: [
    // controllers
    AuthController,
    DealsController,
    CatalogController,
    SourcesController,
    ProductsController,
    DraftsController,
    AdminController,
    StatsController,
    // jobs
    CollectDealsJob,
    // services
    CollectionService,
    PricingService,
    ScoringService,
    CategorizationService,
    DealabsDraftService,
    IdealoReferenceService,
    SeedService,
  ],
});
