import type {
  DealDetails,
  DealSource,
  DiscoverContext,
  RawDeal,
  TrackedProduct,
} from "./DealSource.ts";

/**
 * Steam's store API rejects requests whose headers look non-browser-like
 * (missing/odd `User-Agent`, no `Accept`) with a 403 — which is exactly
 * what a Workers `fetch()` sends by default. Spoofing a normal browser
 * request is enough to pass; no cookies/session needed, this is a public,
 * unauthenticated endpoint either way.
 */
const STEAM_REQUEST_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
};

interface SteamAppDetailsResponse {
  [appId: string]: {
    success: boolean;
    data?: {
      name: string;
      short_description?: string;
      price_overview?: {
        currency: string;
        initial: number;
        final: number;
        discount_percent: number;
      };
      is_free?: boolean;
    };
  };
}

interface SteamFeaturedCategoriesResponse {
  specials?: { items: SteamFeaturedItem[] };
  top_sellers?: { items: SteamFeaturedItem[] };
  new_releases?: { items: SteamFeaturedItem[] };
}

interface SteamFeaturedItem {
  id: number;
  name: string;
  discounted?: boolean;
  discount_percent?: number;
  original_price?: number;
  final_price?: number;
  currency?: string;
  header_image?: string;
  /** From the search row's review tooltip, when it shows one. */
  review_count?: number;
  review_percent?: number;
}

/**
 * Steam's `short_description` field is plain text that still contains a
 * handful of HTML tags (`<br>`, the odd `<i>`/`<b>`) — strip them and
 * collapse whitespace so it can be pasted straight into a Dealabs post.
 */
function stripHtml(html: string | undefined): string | undefined {
  if (!html) {
    return undefined;
  }

  const text = html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

  return text.length > 0 ? text : undefined;
}

/**
 * Default cap on how many pages of {@link fetchAllSpecials} to request —
 * `pageSize` each, so 5*100 = up to 500 discounted-game candidates. Kept
 * as a constant (not a config knob like Amazon/Cdiscount's `limit`)
 * because, unlike those, every extra page here is one cheap JSON request
 * with no per-candidate follow-up page to fetch — so there's no real
 * downside to asking for a generous amount up front.
 */
const SPECIALS_PAGE_SIZE = 100;
const SPECIALS_MAX_PAGES = 5;

/**
 * Parses one `<a class="search_result_row" data-ds-appid="..." ...>` row
 * out of Steam's search-results HTML into the same shape as a featured
 * shelf item, so both sources can be merged interchangeably in
 * `discover()`. Only the handful of `data-*` attributes carried directly
 * on the anchor are used (appid, final price in cents, discount percent) —
 * deliberately not the locale-formatted price text inside the row (e.g.
 * "19,99€" / "₩14,500"), which would need currency-specific parsing and
 * isn't needed since `original = final / (1 - discount / 100)` recovers
 * the same number from the attributes alone.
 */
function parseSearchResultRow(row: string): SteamFeaturedItem | null {
  const appId = row.match(/data-ds-appid="(\d+)"/)?.[1];
  const finalCents = row.match(/data-price-final="(\d+)"/)?.[1];
  if (!appId || !finalCents) {
    return null;
  }

  // `data-discount` since late 2025 (was `data-price-discount`).
  const discountPercent = Number(
    row.match(/data-(?:price-)?discount="(-?\d+)"/)?.[1] ?? 0,
  );
  const finalPrice = Number(finalCents);
  const originalPrice =
    discountPercent > 0
      ? Math.round(finalPrice / (1 - discountPercent / 100))
      : finalPrice;
  const name = row.match(/<span class="title">([^<]*)<\/span>/)?.[1]?.trim();
  const imageUrl = row.match(/<img[^>]*src="([^"]+)"/)?.[1];
  const reviews = parseReviewTooltip(row);

  return {
    id: Number(appId),
    name: name || `Steam app ${appId}`,
    discounted: discountPercent > 0,
    discount_percent: discountPercent,
    final_price: finalPrice,
    original_price: originalPrice,
    header_image: imageUrl,
    review_count: reviews?.count,
    review_percent: reviews?.percent,
  };
}

/**
 * "84 % des 6,902 évaluations…" from a search row's review tooltip (the
 * thousands separator depends on the locale: strip everything but digits).
 */
export function parseReviewTooltip(
  row: string,
): { percent: number; count: number } | undefined {
  const tooltip = row.match(
    /search_review_summary[^>]*data-tooltip-html="([^"]*)"/,
  )?.[1];
  // `\s` covers the narrow no-break spaces some locales group digits with.
  const match = tooltip?.match(/(\d{1,3})\s?%[^\d]*([\d.,\s]+)/);
  if (!match) {
    return undefined;
  }
  const count = Number(match[2].replace(/\D/g, ""));
  return count > 0 ? { percent: Number(match[1]), count } : undefined;
}

/**
 * Games with fewer reviews than this are skipped: Dealabs votes for games
 * people know, and a -40 % on an unknown indie stays cold whatever the price.
 */
export const MIN_STEAM_REVIEWS = 1000;

/**
 * Steam always sells its own games, and the struck price on a Steam
 * special is the game's actual regular price — not a "prix conseillé" —
 * so it is a trustworthy reference (see `ScoringService`).
 */
const STEAM_DETAILS: DealDetails = {
  sellerName: "Steam",
  soldByMerchant: true,
  shippedByMerchant: true,
  condition: "new",
  listPriceKind: "regular",
};

interface SteamReviewSummaryResponse {
  success?: number;
  query_summary?: { total_positive?: number; total_reviews?: number };
}

/**
 * Steam's public review summary for one game (same unauthenticated
 * endpoint the store page itself uses). The positive ratio is mapped onto
 * a 0-5 scale so it can be scored like any merchant's star rating.
 */
async function fetchReviewSummary(
  appId: string,
): Promise<Pick<DealDetails, "productRating" | "productReviewCount">> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/appreviews/${appId}?json=1&language=all&purchase_type=all&num_per_page=0`,
      { headers: STEAM_REQUEST_HEADERS },
    );
    if (!response.ok) {
      return {};
    }
    const json = (await response.json()) as SteamReviewSummaryResponse;
    const total = json.query_summary?.total_reviews ?? 0;
    const positive = json.query_summary?.total_positive ?? 0;
    if (!json.success || total === 0) {
      return {};
    }
    return {
      productRating: Math.round((positive / total) * 50) / 10,
      productReviewCount: total,
    };
  } catch {
    return {};
  }
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await fn(items[index]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

interface SteamStoreFacts {
  summary?: string;
  genres: string[];
  developers: string[];
  publishers: string[];
  releaseDate?: string;
  metacritic?: number;
}

/**
 * The game's store-page facts, in French (`l=french`). One app per call:
 * the endpoint only batches several appids with `filters=price_overview`.
 */
async function fetchStoreFacts(
  appId: string,
): Promise<SteamStoreFacts | undefined> {
  try {
    const response = await fetch(
      `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=fr&l=french`,
      { headers: STEAM_REQUEST_HEADERS },
    );
    if (!response.ok) {
      return undefined;
    }
    const json = (await response.json()) as Record<
      string,
      {
        success: boolean;
        data?: {
          short_description?: string;
          genres?: Array<{ description: string }>;
          developers?: string[];
          publishers?: string[];
          release_date?: { date?: string; coming_soon?: boolean };
          metacritic?: { score?: number };
        };
      }
    >;
    const data = json[appId]?.data;
    if (!json[appId]?.success || !data) {
      return undefined;
    }
    return {
      summary: stripHtml(data.short_description),
      genres: (data.genres ?? []).map((genre) => genre.description),
      developers: (data.developers ?? []).slice(0, 2),
      // Publishers often lists regional entries ("FromSoftware (Japan)",
      // "方块游戏 (Asia)"): the first one is the main publisher.
      publishers: (data.publishers ?? [])
        .slice(0, 1)
        .map((name) => name.replace(/\s*\([^)]*\)\s*$/, "")),
      releaseDate: data.release_date?.date || undefined,
      metacritic: data.metacritic?.score,
    };
  } catch {
    return undefined;
  }
}

/**
 * A factual French description for the deal page and the Dealabs post:
 * Steam's own summary, then one line per fact Steam gave us. Nothing is
 * written that Steam didn't state.
 */
export function buildSteamDescription(
  facts: SteamStoreFacts,
  reviews: Pick<DealDetails, "productRating" | "productReviewCount">,
): string | undefined {
  const lines: string[] = [];
  if (facts.genres.length) {
    lines.push(`- Genres : ${facts.genres.join(", ")}`);
  }
  const studio = [
    facts.developers.length
      ? `Développeur : ${facts.developers.join(", ")}`
      : null,
    facts.publishers.length &&
    facts.publishers.join() !== facts.developers.join()
      ? `Éditeur : ${facts.publishers.join(", ")}`
      : null,
  ].filter(Boolean);
  if (studio.length) {
    lines.push(`- ${studio.join(" · ")}`);
  }
  if (facts.releaseDate) {
    lines.push(`- Sortie : ${facts.releaseDate}`);
  }
  if (reviews.productRating !== undefined && reviews.productReviewCount) {
    lines.push(
      `- Avis Steam : ${Math.round((reviews.productRating / 5) * 100)} % positifs sur ${reviews.productReviewCount.toLocaleString("fr-FR")} avis`,
    );
  }
  if (facts.metacritic) {
    lines.push(`- Metacritic : ${facts.metacritic}/100`);
  }

  const text = [facts.summary, lines.join("\n")].filter(Boolean).join("\n\n");
  return text || undefined;
}

/**
 * How many games get their store facts fetched per run. Steam's store API
 * starts answering 429 past roughly one request per second; games beyond
 * the cap simply stay "stale" and are picked up by the next run.
 */
const STORE_FACTS_PER_RUN = 40;
const STORE_FACTS_SPACING_MS = 1_100;

/**
 * Attaches Steam's fixed details, review stats and a store-page
 * description — only for games whose details are stale (24h), see
 * `DiscoverContext`.
 */
async function withSteamDetails(
  deals: RawDeal[],
  context?: DiscoverContext,
): Promise<RawDeal[]> {
  const stale = deals
    .filter((deal) => !context || context.needsDetails(deal.externalId))
    .slice(0, STORE_FACTS_PER_RUN);

  const facts = new Map<string, SteamStoreFacts | undefined>();
  for (const [index, deal] of stale.entries()) {
    context?.progress?.(
      "Fiches des jeux (description, avis)",
      index + 1,
      stale.length,
    );
    if (index > 0) {
      await new Promise((resolve) =>
        setTimeout(resolve, STORE_FACTS_SPACING_MS),
      );
    }
    facts.set(deal.externalId, await fetchStoreFacts(deal.externalId));
  }
  // The review endpoint is a different, more lenient one: parallel is fine.
  const reviews = new Map(
    await mapLimit(
      stale,
      8,
      async (deal) =>
        [deal.externalId, await fetchReviewSummary(deal.externalId)] as const,
    ),
  );

  return deals.map((deal) => {
    if (!facts.has(deal.externalId)) {
      return deal;
    }
    const gameReviews = reviews.get(deal.externalId) ?? {};
    const gameFacts = facts.get(deal.externalId);
    return {
      ...deal,
      description:
        (gameFacts && buildSteamDescription(gameFacts, gameReviews)) ??
        deal.description,
      // Keeps the search row's review counts if the summary request failed.
      details: { ...STEAM_DETAILS, ...deal.details, ...gameReviews },
    };
  });
}

/**
 * Collector for video games, using Steam's official (no auth required)
 * store API: https://store.steampowered.com/api/appdetails
 */
export class SteamCollector implements DealSource {
  id = "steam";
  name = "Steam";

  async collect(
    products: TrackedProduct[],
    context?: DiscoverContext,
  ): Promise<RawDeal[]> {
    return withSteamDetails(await this.collectPrices(products), context);
  }

  protected async collectPrices(
    products: TrackedProduct[],
  ): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];

    for (const product of products) {
      if (!product.steamAppId) {
        continue;
      }

      try {
        const response = await fetch(
          `https://store.steampowered.com/api/appdetails?appids=${product.steamAppId}&cc=fr&filters=basic,price_overview`,
          { headers: STEAM_REQUEST_HEADERS },
        );

        if (!response.ok) {
          continue;
        }

        const json = (await response.json()) as SteamAppDetailsResponse;
        const entry = json[String(product.steamAppId)];
        const priceOverview = entry?.data?.price_overview;

        if (!entry?.success || !priceOverview) {
          // Free game, region-locked, or app not found: nothing to record.
          continue;
        }

        deals.push({
          externalId: String(product.steamAppId),
          productId: product.id,
          title: product.title,
          url: product.url,
          price: priceOverview.final / 100,
          listPrice:
            priceOverview.initial > priceOverview.final
              ? priceOverview.initial / 100
              : undefined,
          description: stripHtml(entry.data?.short_description),
          currency: priceOverview.currency,
          availability: "in_stock",
          merchantId: product.merchantId,
          categoryId: product.categoryId,
        });
      } catch {
        // Network error for this product: skip it, other products continue.
      }
    }

    return deals;
  }

  /**
   * Pages through Steam's own "Specials" browse listing
   * (`/search/results/?specials=1`) — the same undocumented-but-stable
   * endpoint the store's infinite-scroll specials page itself calls — to
   * surface the *full* current discount list, not just the ~30-40 games
   * the curated homepage shelves in `discover()` happen to feature. Each
   * page's `results_html` is a string of search-result rows; parsed with
   * {@link parseSearchResultRow} rather than a DOM parser since only a
   * few `data-*` attributes on each row are needed.
   *
   * Best-effort and additive only: this is an unofficial endpoint that
   * could change shape without notice, so any failure (bad response,
   * unexpected JSON, zero rows parsed) just stops pagination early and
   * returns whatever was already collected — it never throws, so a
   * change here can't take down the curated-shelves `discover()` already
   * relies on.
   */
  private async fetchAllSpecials(): Promise<SteamFeaturedItem[]> {
    const items: SteamFeaturedItem[] = [];

    for (let page = 0; page < SPECIALS_MAX_PAGES; page++) {
      try {
        const start = page * SPECIALS_PAGE_SIZE;
        const response = await fetch(
          `https://store.steampowered.com/search/results/?query=&start=${start}&count=${SPECIALS_PAGE_SIZE}&specials=1&cc=fr&l=french&infinite=1`,
          { headers: STEAM_REQUEST_HEADERS },
        );
        if (!response.ok) {
          break;
        }

        const json = (await response.json()) as {
          results_html?: string;
          total_count?: number;
        };
        const html = json.results_html;
        if (!html) {
          break;
        }

        // One `<a href=… class="search_result_row …">` per game (the
        // class is no longer the first attribute: split on the anchor).
        const rows = html
          .split("<a ")
          .slice(1)
          .filter((row) => row.includes("search_result_row"));
        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          const item = parseSearchResultRow(row);
          if (item) {
            items.push(item);
          }
        }

        if (
          rows.length < SPECIALS_PAGE_SIZE ||
          (json.total_count !== undefined && items.length >= json.total_count)
        ) {
          break;
        }
      } catch {
        break;
      }
    }

    return items;
  }

  /**
   * Auto-discovers currently discounted games — no tracked product needed.
   * Real, unauthenticated endpoint used by the store's own homepage.
   *
   * The curated "Specials" shelf alone (`specials.items`) is a short,
   * hand-picked list — easily missing big titles that are discounted but
   * being featured elsewhere on the homepage instead (e.g. a popular new
   * release on sale shows up under "Top Sellers", not "Specials").
   * Scanning that shelf too, from the very same response, surfaces those
   * without any extra request — filtered down to the ones that actually
   * carry a discount. "New Releases" is left out: mostly unknown games
   * with no reviews yet. On top of that, `fetchAllSpecials()` pages
   * through the store's full specials listing so the curated shelves
   * aren't the volume ceiling.
   */
  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Liste des promotions Steam");
    return withSteamDetails(await this.discoverPrices(), context);
  }

  protected async discoverPrices(): Promise<RawDeal[]> {
    const response = await fetch(
      "https://store.steampowered.com/api/featuredcategories?cc=fr&l=french",
      { headers: STEAM_REQUEST_HEADERS },
    );

    if (!response.ok) {
      throw new Error(`Steam featuredcategories returned ${response.status}`);
    }

    const json = (await response.json()) as SteamFeaturedCategoriesResponse;
    const allSpecials = await this.fetchAllSpecials();

    const itemsById = new Map<number, SteamFeaturedItem>();
    for (const shelf of [
      json.specials?.items,
      json.top_sellers?.items,
      allSpecials,
    ]) {
      for (const item of shelf ?? []) {
        if (!itemsById.has(item.id)) {
          itemsById.set(item.id, item);
        }
      }
    }

    // The search rows carry review counts the shelves don't: shelf items
    // found in the search get them too; the others are checked later
    // (`withSteamDetails`, then the quality gate).
    const searched = new Map(allSpecials.map((item) => [item.id, item]));
    return Array.from(itemsById.values())
      .map((item) => ({
        ...item,
        review_count: item.review_count ?? searched.get(item.id)?.review_count,
        review_percent:
          item.review_percent ?? searched.get(item.id)?.review_percent,
      }))
      .filter((item) => item.discounted && item.final_price !== undefined)
      .filter(
        (item) =>
          item.review_count === undefined ||
          item.review_count >= MIN_STEAM_REVIEWS,
      )
      .map((item) => {
        const price = (item.final_price as number) / 100;
        const listPrice =
          item.original_price !== undefined
            ? item.original_price / 100
            : undefined;

        return {
          externalId: String(item.id),
          title: item.name,
          url: `https://store.steampowered.com/app/${item.id}`,
          imageUrl: item.header_image,
          price,
          // Steam always sends `original_price` on a discounted item, but
          // guard anyway: a list price that isn't above the final price
          // would render as "-0%".
          listPrice:
            listPrice !== undefined && listPrice > price
              ? listPrice
              : undefined,
          currency: item.currency ?? "EUR",
          availability: "in_stock" as const,
          categoryId: "video-games",
          merchantId: "steam",
          details:
            item.review_count !== undefined && item.review_percent !== undefined
              ? {
                  ...STEAM_DETAILS,
                  productRating: Math.round(item.review_percent / 2) / 10,
                  productReviewCount: item.review_count,
                }
              : undefined,
        };
      });
  }
}
