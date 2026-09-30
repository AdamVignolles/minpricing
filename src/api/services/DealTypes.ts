import type { Infer } from "alepha";

import type { dealEntity } from "../entities/Deal.ts";

export type Deal = Infer<typeof dealEntity.schema>;
