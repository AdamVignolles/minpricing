import type { DealSource, RawDeal, TrackedProduct } from "./DealSource.ts";

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

  const discountPercent = Number(
    row.match(/data-price-discount="(-?\d+)"/)?.[1] ?? 0,
  );
  const finalPrice = Number(finalCents);
  const originalPrice =
    discountPercent > 0
      ? Math.round(finalPrice / (1 - discountPercent / 100))
      : finalPrice;
  const name = row.match(/<span class="title">([^<]*)<\/span>/)?.[1]?.trim();
  const imageUrl = row.match(/<img[^>]*src="([^"]+)"/)?.[1];

  return {
    id: Number(appId),
    name: name || `Steam app ${appId}`,
    discounted: discountPercent > 0,
    discount_percent: discountPercent,
    final_price: finalPrice,
    original_price: originalPrice,
    header_image: imageUrl,
  };
}

/**
 * Collector for video games, using Steam's official (no auth required)
 * store API: https://store.steampowered.com/api/appdetails
 */
export class SteamCollector implements DealSource {
  id = "steam";
  name = "Steam";

  async collect(products: TrackedProduct[]): Promise<RawDeal[]> {
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

        const rows = html.split('<a class="search_result_row').slice(1);
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
   * release on sale shows up under "Top Sellers"/"New Releases", not
   * "Specials"). Scanning those shelves too, from the very same response,
   * surfaces those without any extra request — they're simply filtered
   * down to the ones that actually carry a discount. On top of that,
   * `fetchAllSpecials()` pages through the store's full specials listing
   * so the curated shelves aren't the volume ceiling.
   */
  async discover(): Promise<RawDeal[]> {
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
      json.new_releases?.items,
      allSpecials,
    ]) {
      for (const item of shelf ?? []) {
        if (!itemsById.has(item.id)) {
          itemsById.set(item.id, item);
        }
      }
    }

    return Array.from(itemsById.values())
      .filter((item) => item.discounted && item.final_price !== undefined)
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
        };
      });
  }
}
