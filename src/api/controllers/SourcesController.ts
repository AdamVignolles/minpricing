import { z } from "alepha";
import { $repository } from "alepha/orm";
import { $action } from "alepha/server";

import { sourceEntity } from "../entities/Source.ts";

export class SourcesController {
  protected sources = $repository(sourceEntity);

  listSources = $action({
    method: "GET",
    path: "/sources",
    schema: { response: z.array(sourceEntity.schema) },
    handler: async () => this.sources.findMany(),
  });
}
