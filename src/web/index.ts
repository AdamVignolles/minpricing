import { $module } from "alepha";

import { AppRouter } from "./AppRouter.ts";

export const WebModule = $module({
  name: "minpricing.web",
  services: [AppRouter],
});
