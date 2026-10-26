import { $module } from "alepha";

import { AdminController } from "./controllers/AdminController.ts";
import { AgentsController } from "./controllers/AgentsController.ts";
import { AuthController } from "./controllers/AuthController.ts";
import { CatalogController } from "./controllers/CatalogController.ts";
import { DealsController } from "./controllers/DealsController.ts";
import { DraftsController } from "./controllers/DraftsController.ts";
import { KeepaController } from "./controllers/KeepaController.ts";
import { ProductsController } from "./controllers/ProductsController.ts";
import { SourcesController } from "./controllers/SourcesController.ts";
import { StatsController } from "./controllers/StatsController.ts";
import { CollectDealsJob } from "./jobs/CollectDealsJob.ts";
import { AgentsService } from "./services/AgentsService.ts";
import { AmazonWatchService } from "./services/AmazonWatchService.ts";
import { AutoPublishService } from "./services/AutoPublishService.ts";
import { CategorizationService } from "./services/CategorizationService.ts";
import { CollectionProgressService } from "./services/CollectionProgressService.ts";
import { CollectionService } from "./services/CollectionService.ts";
import { DealabsDraftService } from "./services/DealabsDraftService.ts";
import { DealabsHistoryService } from "./services/DealabsHistoryService.ts";
import { DealPageCheckService } from "./services/DealPageCheckService.ts";
import { HotWatchlistService } from "./services/HotWatchlistService.ts";
import { IdealoReferenceService } from "./services/IdealoReferenceService.ts";
import { ItadService } from "./services/ItadService.ts";
import { MarketReferenceService } from "./services/MarketReferenceService.ts";
import { MyDealabsPostsService } from "./services/MyDealabsPostsService.ts";
import { PriceSeriesService } from "./services/PriceSeriesService.ts";
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
    KeepaController,
    AgentsController,
    // jobs
    CollectDealsJob,
    // services
    CollectionService,
    AgentsService,
    CollectionProgressService,
    AutoPublishService,
    PricingService,
    PriceSeriesService,
    HotWatchlistService,
    AmazonWatchService,
    MyDealabsPostsService,
    ScoringService,
    CategorizationService,
    DealabsDraftService,
    IdealoReferenceService,
    MarketReferenceService,
    DealabsHistoryService,
    DealPageCheckService,
    ItadService,
    SeedService,
  ],
});
