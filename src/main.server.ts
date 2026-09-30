import { Alepha, run } from "alepha";
import { AlephaApiJobs } from "alepha/api/jobs";

import { ApiModule } from "./api/index.ts";
import { WebModule } from "./web/index.ts";

const alepha = Alepha.create();

alepha.with(AlephaApiJobs);
alepha.with(ApiModule);
alepha.with(WebModule);

run(alepha);
