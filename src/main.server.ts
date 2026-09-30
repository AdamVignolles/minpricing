import { Alepha, run } from "alepha";
import { AlephaApiJobsQueue } from "alepha/api/jobs";

import { ApiModule } from "./api/index.ts";
import { WebModule } from "./web/index.ts";

const alepha = Alepha.create();

// `AlephaApiJobsQueue` (rather than the plain `AlephaApiJobs`) so that on
// Cloudflare `alepha platform up` provisions a real Queue and sets
// `CLOUDFLARE_QUEUE_NAME` automatically. `deals.collect` scrapes 3 sources
// with a headless browser and easily runs past the ~30s `waitUntil` budget
// direct-mode dispatch gets on Workers; a queue consumer gets 15 minutes.
alepha.with(AlephaApiJobsQueue);
alepha.with(ApiModule);
alepha.with(WebModule);

run(alepha);
