import { AlephaSigil } from "@alepha/lore/sigil";
import { Alepha, run } from "alepha";
import { AlephaApiJobsQueue } from "alepha/api/jobs";
import { queueWorkerOptions } from "alepha/queue";
import { bodyParserOptions } from "alepha/server";

import { ApiModule } from "./api/index.ts";
import { WebModule } from "./web/index.ts";

const alepha = Alepha.create();

// `AlephaApiJobsQueue` (rather than the plain `AlephaApiJobs`) so that on
// Cloudflare `alepha platform up` provisions a real Queue and sets
// `CLOUDFLARE_QUEUE_NAME` automatically. `deals.collect` scrapes 3 sources
// with a headless browser and easily runs past the ~30s `waitUntil` budget
// direct-mode dispatch gets on Workers; a queue consumer gets 15 minutes.
alepha.with(AlephaApiJobsQueue);
// Two workers: a collection run takes many minutes, and the 5-minute
// publishing-schedule tick (`PublishScheduleJob`) must not wait behind it.
// `CollectionService.runAll` already skips a run while one is going.
alepha.store.set(queueWorkerOptions, {
  interval: 1000,
  maxInterval: 32000,
  concurrency: 2,
});
// The agents' files (`PUT /agent/data/*`, reports) go up to the 2 MB cap
// `AgentFilesService` enforces; the framework default stops at 100 kB.
alepha.store.set(bodyParserOptions, { inflate: true, limit: 2_500_000 });
// Crash/telemetry reporting to Lore. Inert until `SIGIL_KEY` is set (minted by
// `lore deploy`) and production-only, so dev and tests send nothing.
alepha.with(AlephaSigil);
alepha.with(ApiModule);
alepha.with(WebModule);

run(alepha);
