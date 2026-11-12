import { $inject, z } from "alepha";
import { $action } from "alepha/server";

import { $adminSession } from "../services/AdminAuth.ts";
import { CatalogService } from "../services/CatalogService.ts";

/**
 * Admin side of the catalogue collection (`CatalogService`): what each
 * source of `config/watch-sources.json` holds, the probe that must pass
 * before a source is marked `verified`, and a pass on demand.
 */
export class CatalogAdminController {
  protected catalog = $inject(CatalogService);

  catalogStatus = $action({
    method: "GET",
    path: "/admin/catalog",
    use: [$adminSession()],
    schema: { response: z.any() },
    handler: () => this.catalog.status(),
  });

  catalogProbe = $action({
    method: "POST",
    path: "/admin/catalog/:id/probe",
    use: [$adminSession()],
    schema: { params: z.object({ id: z.text() }), response: z.any() },
    handler: ({ params }) => this.catalog.probe(params.id),
  });

  /** Starts a pass now, whatever the hour; answers at once. */
  catalogRun = $action({
    method: "POST",
    path: "/admin/catalog/run",
    use: [$adminSession()],
    schema: { response: z.object({ started: z.boolean() }) },
    handler: () => {
      void this.catalog.runDue(new Date(), true).catch(() => undefined);
      return { started: true };
    },
  });
}
