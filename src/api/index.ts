import { $module } from "alepha";
import { AlephaMcp, StreamableHttpMcpTransport } from "alepha/mcp";

import { AdminController } from "./controllers/AdminController.ts";
import { AgentApiController } from "./controllers/AgentApiController.ts";
import { AgentsController } from "./controllers/AgentsController.ts";
import { AuthController } from "./controllers/AuthController.ts";
import { CatalogController } from "./controllers/CatalogController.ts";
import { DealsController } from "./controllers/DealsController.ts";
import { DraftsController } from "./controllers/DraftsController.ts";
import { KeepaController } from "./controllers/KeepaController.ts";
import { McpOAuthController } from "./controllers/McpOAuthController.ts";
import { McpTools } from "./controllers/McpTools.ts";
import { ProductsController } from "./controllers/ProductsController.ts";
import { PublishScheduleController } from "./controllers/PublishScheduleController.ts";
import { SourcesController } from "./controllers/SourcesController.ts";
import { StatsController } from "./controllers/StatsController.ts";
import { CollectDealsJob } from "./jobs/CollectDealsJob.ts";
import { PublishScheduleJob } from "./jobs/PublishScheduleJob.ts";
import { AgentFilesService } from "./services/AgentFilesService.ts";
import { AgentsService } from "./services/AgentsService.ts";
import { AmazonWatchService } from "./services/AmazonWatchService.ts";
import { AutoPublishService } from "./services/AutoPublishService.ts";
import { CategorizationService } from "./services/CategorizationService.ts";
import { CollectionProgressService } from "./services/CollectionProgressService.ts";
import { CollectionService } from "./services/CollectionService.ts";
import { DealabsCommentsService } from "./services/DealabsCommentsService.ts";
import { DealabsDraftService } from "./services/DealabsDraftService.ts";
import { DealabsHistoryService } from "./services/DealabsHistoryService.ts";
import { DealPageCheckService } from "./services/DealPageCheckService.ts";
import { HotWatchlistService } from "./services/HotWatchlistService.ts";
import { IdealoReferenceService } from "./services/IdealoReferenceService.ts";
import { ItadService } from "./services/ItadService.ts";
import { MarketReferenceService } from "./services/MarketReferenceService.ts";
import { McpOAuthService } from "./services/McpOAuthService.ts";
import { MyDealabsPostsService } from "./services/MyDealabsPostsService.ts";
import { PriceSeriesService } from "./services/PriceSeriesService.ts";
import { PricingService } from "./services/PricingService.ts";
import { PublishProgressService } from "./services/PublishProgressService.ts";
import { PublishScheduleService } from "./services/PublishScheduleService.ts";
import { ScoringService } from "./services/ScoringService.ts";
import { SeedService } from "./services/SeedService.ts";

export const ApiModule = $module({
  name: "minpricing.api",
  imports: [AlephaMcp],
  services: [
    // read-only MCP for Claude (OAuth login with the admin credentials)
    StreamableHttpMcpTransport,
    McpOAuthController,
    McpOAuthService,
    McpTools,
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
    // agent write API (AGENT_TOKEN): bounded configs, reports, plan
    AgentApiController,
    PublishScheduleController,
    // jobs
    CollectDealsJob,
    PublishScheduleJob,
    // services
    CollectionService,
    AgentsService,
    AgentFilesService,
    PublishScheduleService,
    CollectionProgressService,
    PublishProgressService,
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
    DealabsCommentsService,
    DealabsHistoryService,
    DealPageCheckService,
    ItadService,
    SeedService,
  ],
});
