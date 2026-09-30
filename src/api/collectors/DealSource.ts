import type { Infer } from "alepha";

import type { trackedProductEntity } from "../entities/TrackedProduct.ts";

export type TrackedProduct = Infer<typeof trackedProductEntity.schema>;

/**
 * A raw offer, as returned by a collector, before normalization.
 */
export interface RawDeal {
  externalId: string;
  title: string;
  url: string;
  imageUrl?: string;
  price: number;
  currency: string;
  availability?: "in_stock" | "out_of_stock" | "unknown";
  merchantId?: string;
  categoryId?: string;
}

/**
 * A collector turns a list of tracked products from one source into raw
 * offers. It must never throw for a single failing product: skip it and
 * let the caller log the failure, so one bad product never blocks the rest.
 *
 * `collect` covers products you tell it about (manual entry, or a specific
 * Steam appId). `discover` is for sources that can find deals on their own
 * (Steam specials API, Amazon/Cdiscount "bons plans" pages) — no tracked
 * product needed, it returns whatever it found this run.
 */
export interface DealSource {
  id: string;
  name: string;
  collect?(products: TrackedProduct[]): Promise<RawDeal[]>;
  discover?(): Promise<RawDeal[]>;
}
