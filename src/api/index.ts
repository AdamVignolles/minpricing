import { $module } from "alepha";

import { HelloController } from "./controllers/HelloController.ts";

export const ApiModule = $module({
  name: "minpricing.api",
  services: [HelloController],
});
