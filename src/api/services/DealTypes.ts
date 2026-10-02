import type { Infer } from "alepha";

import type { dealEntity } from "../entities/Deal.ts";

export type Deal = Infer<typeof dealEntity.schema>;

/**
 * Fallback merchant for sources that discover offers on a single
 * merchant's own site. Shared by the collection pipeline and the
 * backfill so both can never disagree about who sells what.
 */
export const DEFAULT_MERCHANT_BY_SOURCE: Record<string, string> = {
  amazon: "amazon",
  cdiscount: "cdiscount",
  steam: "steam",
};
