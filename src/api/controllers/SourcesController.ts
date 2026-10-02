import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { sourceEntity } from "../entities/Source.ts";
import { $adminSession } from "../services/AdminAuth.ts";

export class SourcesController {
  protected sources = $repository(sourceEntity);

  listSources = $action({
    method: "GET",
    path: "/sources",
    use: [$adminSession()],
    schema: { response: z.array(sourceEntity.schema) },
    handler: async () => this.sources.findMany(),
  });
}
