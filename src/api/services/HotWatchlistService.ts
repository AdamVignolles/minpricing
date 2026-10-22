import { $inject } from "alepha";
import { $cache } from "alepha/cache";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";

import { parseDealabsSearch } from "./dealabsSearch.ts";

/**
 * A product that already went hot on Dealabs: posted again once its
 * price is back to what made it hot (and the old deal has expired), it is
 * the deal most likely to burn again — measured on our own posts (the
 * Lenovo IdeaPad: 925° before, 948° when we posted it back at its price).
 */
export interface HotProduct {
  threadId: string;
  title: string;
  /** Price the hot deal was at. */
  price: number;
  temperature: number;
  publishedAt: string;
  isExpired: boolean;
  /** Last time we looked for it on Amazon. */
  checkedAt?: string;
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

/** Hot pages read once a day (~30 threads each, the last days). */
const HOT_PAGES = 15;
const SPACING_MS = 2_000;
const MIN_TEMPERATURE = 300;
const MIN_PRICE = 10;
const KEEP_DAYS = 120;
const MAX_ITEMS = 300;

/**
 * The watch list: Amazon deals that reached 300°+ on Dealabs in the last
 * four months, read from Dealabs' public "hot" pages once a day (plain
 * fetch, paced) and kept in the cache. Merchant links aren't in those
 * pages (only behind Dealabs' click-out redirect, which we don't follow:
 * it would count as visits), so products are found back on Amazon by
 * title — see `RelaunchCollector`.
 */
export class HotWatchlistService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected store = $cache<{ refreshedAt: string; items: HotProduct[] }>({
    name: "hot-watchlist",
    ttl: [KEEP_DAYS, "days"],
  });

  async list(): Promise<HotProduct[]> {
    return (await this.store.get("list").catch(() => undefined))?.items ?? [];
  }

  /** Reads Dealabs' hot pages when the list is over 20 h old. */
  async refreshIfStale(progress?: (done: number, total: number) => void) {
    const stored = await this.store.get("list").catch(() => undefined);
    const now = new Date(this.dateTime.nowISOString()).getTime();
    if (
      stored &&
      now - new Date(stored.refreshedAt).getTime() < 20 * 3600 * 1000
    ) {
      return;
    }
    const byId = new Map((stored?.items ?? []).map((i) => [i.threadId, i]));
    for (let page = 1; page <= HOT_PAGES; page++) {
      progress?.(page, HOT_PAGES);
      if (page > 1) await new Promise((r) => setTimeout(r, SPACING_MS));
      try {
        const response = await fetch(
          `https://www.dealabs.com/hot?page=${page}`,
          { headers: HEADERS, signal: AbortSignal.timeout(20_000) },
        );
        if (!response.ok) break;
        for (const thread of parseDealabsSearch(await response.text())) {
          if (!/^amazon$/i.test(thread.merchant?.trim() ?? "")) continue;
          if (thread.temperature < MIN_TEMPERATURE) continue;
          if (thread.price < MIN_PRICE) continue;
          const known = byId.get(thread.id);
          byId.set(thread.id, {
            threadId: thread.id,
            title: thread.title,
            price: thread.price,
            temperature: Math.round(thread.temperature),
            publishedAt: thread.publishedAt,
            isExpired: thread.isExpired,
            checkedAt: known?.checkedAt,
          });
        }
      } catch (error) {
        this.log.warn("Dealabs hot page unreadable", {
          page,
          error: error instanceof Error ? error.message : String(error),
        });
        break;
      }
    }
    const since = now - KEEP_DAYS * 86_400_000;
    const items = [...byId.values()]
      .filter((item) => new Date(item.publishedAt).getTime() >= since)
      .sort((a, b) => b.temperature - a.temperature)
      .slice(0, MAX_ITEMS);
    await this.store
      .set("list", { refreshedAt: this.dateTime.nowISOString(), items })
      .catch(() => undefined);
  }

  /**
   * The next products to look for, least recently checked first, among
   * those whose hot deal is over (expired, or posted three weeks ago or
   * more): re-posting a live deal is a duplicate. Marks them checked.
   */
  async nextBatch(size: number): Promise<HotProduct[]> {
    const stored = await this.store.get("list").catch(() => undefined);
    if (!stored) return [];
    const now = new Date(this.dateTime.nowISOString()).getTime();
    const over = (item: HotProduct) =>
      item.isExpired ||
      now - new Date(item.publishedAt).getTime() > 21 * 86_400_000;
    const batch = stored.items
      .filter(over)
      .sort((a, b) => (a.checkedAt ?? "").localeCompare(b.checkedAt ?? ""))
      .slice(0, size);
    const at = this.dateTime.nowISOString();
    for (const item of batch) item.checkedAt = at;
    await this.store.set("list", stored).catch(() => undefined);
    return batch;
  }
}
