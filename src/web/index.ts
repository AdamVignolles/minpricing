import { AlephaSigil } from "@alepha/lore/sigil";
import { $module } from "alepha";

import { AppRouter } from "./AppRouter.ts";

export const WebModule = $module({
  name: "minpricing.web",
  // Reports page views, web vitals and errors to Lore; needs SIGIL_KEY (server only, production only).
  imports: [AlephaSigil],
  services: [AppRouter],
});
