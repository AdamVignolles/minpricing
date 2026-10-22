import type { DealSource, DiscoverContext, RawDeal } from "./DealSource.ts";
import { parseJoybuyOffers } from "./joybuyOffers.ts";
import {
  leclercFeaturedEans,
  parseCastoramaTiles,
  parseFootLockerCards,
  parseGrosbillCards,
  parseItJustGoodCards,
  parseLeclercProducts,
  parseLenovoProducts,
  parseNikeWall,
} from "./retailOffers.ts";
import {
  type GamerPowerGiveaway,
  giveawayToDeal,
  parseEpicFreeGames,
  selectGiveaways,
  parseGogCatalog,
  parseIkeaOffers,
  parseLidlSearch,
  parseNintendoSearch,
  parsePlayStationGrid,
  parseXboxDeals,
} from "./storeOffers.ts";

/**
 * Stores read with plain `fetch` — their own public JSON APIs or
 * server-rendered pages, no browser: a few requests each, seconds per run.
 * Parsing lives in `storeOffers.ts`.
 */

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    headers: { ...HEADERS, ...init?.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${new URL(url).host} returned ${response.status}`);
  }
  return response;
}

const fetchJson = async (url: string, init?: RequestInit) =>
  (await fetchOk(url, init)).json() as Promise<unknown>;
const fetchText = async (url: string) => (await fetchOk(url)).text();

/** Same item listed twice (two pages, two categories): keep the first. */
function uniqueById(deals: RawDeal[]): RawDeal[] {
  const seen = new Set<string>();
  return deals.filter((deal) => {
    if (seen.has(deal.externalId)) return false;
    seen.add(deal.externalId);
    return true;
  });
}

/** Epic Games Store: the free games of the week (always hot on Dealabs). */
export class EpicCollector implements DealSource {
  id = "epic";
  name = "Epic Games Store (jeux gratuits)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Jeux gratuits de la semaine");
    return parseEpicFreeGames(
      await fetchJson(
        "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=fr&country=FR&allowCountries=FR",
      ),
    );
  }
}

/** GOG: discounted games, most popular first ("trending"). */
export class GogCollector implements DealSource {
  id = "gog";
  name = "GOG (promos)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const page of [1, 2]) {
      context?.progress?.("Promotions GOG", page, 2);
      deals.push(
        ...parseGogCatalog(
          await fetchJson(
            `https://catalog.gog.com/v1/catalog?limit=48&order=desc:trending&discounted=eq:true&productType=in:game,pack&page=${page}&countryCode=FR&locale=fr-FR&currencyCode=EUR`,
          ),
        ),
      );
    }
    return uniqueById(deals);
  }
}

/** Nintendo eShop: discounted Switch / Switch 2 games, most popular first. */
export class NintendoCollector implements DealSource {
  id = "nintendo";
  name = "Nintendo eShop (promos)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Promotions eShop");
    const filter = encodeURIComponent(
      "type:GAME AND price_has_discount_b:true AND system_type:nintendoswitch*",
    );
    return parseNintendoSearch(
      await fetchJson(
        `https://searching.nintendo-europe.com/fr/select?q=*&fq=${filter}&sort=popularity%20asc&start=0&rows=40&wt=json`,
      ),
    );
  }
}

/**
 * PlayStation Store "offers" category through the store's own GraphQL
 * API: full games only, best sellers of the last 30 days first. The query
 * is a persisted one (hash below, as the store page sends it): if Sony
 * changes it, the run reports an error for this source and nothing else.
 */
const PS_DEALS_CATEGORY = "3f772501-f6f8-49b7-abac-874a88ca4897";
const PS_GRID_QUERY_HASH =
  "88c0b9a1273c6d320c51cd73e390924e21ae28bf09f01cde8b84b1034b16cd03";

export class PlayStationCollector implements DealSource {
  id = "playstation";
  name = "PlayStation Store (promos)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const [index, offset] of [0, 48].entries()) {
      context?.progress?.("Promotions PlayStation Store", index + 1, 2);
      const variables = {
        id: PS_DEALS_CATEGORY,
        pageArgs: { size: 48, offset },
        sortBy: { name: "sales30", isAscending: false },
        filterBy: ["storeDisplayClassification:FULL_GAME"],
        facetOptions: [],
      };
      const extensions = {
        persistedQuery: { version: 1, sha256Hash: PS_GRID_QUERY_HASH },
      };
      deals.push(
        ...parsePlayStationGrid(
          await fetchJson(
            `https://web.np.playstation.com/api/graphql/v1/op?operationName=categoryGridRetrieve&variables=${encodeURIComponent(JSON.stringify(variables))}&extensions=${encodeURIComponent(JSON.stringify(extensions))}`,
            {
              headers: {
                "x-psn-store-locale-override": "fr-FR",
                "content-type": "application/json",
              },
            },
          ),
        ),
      );
    }
    return uniqueById(deals);
  }
}

/** Xbox Store "game deals" channel (state embedded in the page). */
export class XboxCollector implements DealSource {
  id = "xbox";
  name = "Xbox Store (promos)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Promotions Xbox Store");
    return parseXboxDeals(
      await fetchText(
        "https://www.xbox.com/fr-FR/games/browse/DynamicChannel.GameDeals",
      ),
    );
  }
}

/**
 * Lidl's non-food aisles (Parkside, Silvercrest… regulars of Dealabs'
 * hot page), biggest discounts first in each. Clothing is left out: the
 * discount-sorted list is otherwise mostly basics at a few euros.
 */
const LIDL_CATEGORIES: Array<{ label: string; categoryId: string }> = [
  { label: "Bricolage & Jardinage", categoryId: "diy" },
  { label: "Cuisine & Ménage", categoryId: "home" },
  { label: "Maison & Aménagement", categoryId: "home" },
  { label: "Sports & Loisirs", categoryId: "sport" },
  { label: "Bébé, Enfant & Jouets", categoryId: "kids" },
];
const LIDL_PER_CATEGORY = 40;

export class LidlCollector implements DealSource {
  id = "lidl";
  name = "Lidl (non-alimentaire)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const [index, category] of LIDL_CATEGORIES.entries()) {
      context?.progress?.(
        `Rayon ${category.label}`,
        index + 1,
        LIDL_CATEGORIES.length,
      );
      try {
        deals.push(
          ...parseLidlSearch(
            await fetchJson(
              `https://www.lidl.fr/q/api/search?assortment=FR&locale=fr_FR&version=v2.0.0&fetchsize=${LIDL_PER_CATEGORY}&offset=0&q=*&sort=percentageDiscount-desc&category=${encodeURIComponent(category.label)}`,
            ),
            category.categoryId,
          ),
        );
      } catch {
        // One aisle failing doesn't stop the others.
      }
    }
    return uniqueById(deals);
  }
}

/** IKEA's limited-time offers page. */
export class IkeaCollector implements DealSource {
  id = "ikea";
  name = "IKEA (offres limitées)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Offres à durée limitée");
    return parseIkeaOffers(
      await fetchText("https://www.ikea.com/fr/fr/offers/limited-time-offers/"),
    );
  }
}

/**
 * E.Leclerc: the products each universe page features (its CMS JSON
 * lists their EANs), priced through the store's own product API — only
 * those with a discount price are kept. "Bonnes affaires" first.
 */
const LECLERC_UNIVERSES: Array<{ code: string; categoryId?: string }> = [
  { code: "bonnes-affaires" },
  { code: "high-tech" },
  { code: "electromenager", categoryId: "appliances" },
  { code: "maison", categoryId: "home" },
  { code: "bricolage", categoryId: "diy" },
  { code: "jardin", categoryId: "diy" },
  { code: "jouets", categoryId: "kids" },
  { code: "puericulture", categoryId: "kids" },
  { code: "sport-loisirs", categoryId: "sport" },
];
const LECLERC_API = "https://www.e.leclerc/api/rest/live-api";

export class LeclercCollector implements DealSource {
  id = "leclerc";
  name = "E.Leclerc (bonnes affaires)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    const seen = new Set<string>();
    for (const [index, universe] of LECLERC_UNIVERSES.entries()) {
      context?.progress?.(
        `Univers ${universe.code}`,
        index + 1,
        LECLERC_UNIVERSES.length,
      );
      try {
        const eans = leclercFeaturedEans(
          await fetchText(
            `${LECLERC_API}/category-details-by-code/NAVIGATION_${universe.code}`,
          ),
        ).filter((ean) => !seen.has(ean));
        eans.forEach((ean) => seen.add(ean));
        // The product API takes a list of EANs: 20 per request.
        for (let i = 0; i < eans.length; i += 20) {
          const query = eans
            .slice(i, i + 20)
            .map((ean) => `skus=${ean}`)
            .join("&");
          deals.push(
            ...parseLeclercProducts(
              await fetchJson(
                `${LECLERC_API}/stores/0100-0000/products-details-by-skus?${query}`,
              ),
              universe.categoryId,
            ),
          );
        }
      } catch {
        // One universe failing doesn't stop the others.
      }
    }
    return uniqueById(deals);
  }
}

/** Grosbill (PC hardware & tech): its most-requested struck prices. */
export class GrosbillCollector implements DealSource {
  id = "grosbill";
  name = "Grosbill (prix barrés)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const page of [1, 2, 3]) {
      context?.progress?.("Prix barrés", page, 3);
      try {
        deals.push(
          ...parseGrosbillCards(
            await fetchText(
              `https://www.grosbill.com/promotions/prix-barres${page > 1 ? `?page=${page}` : ""}`,
            ),
          ),
        );
      } catch {
        break;
      }
    }
    return uniqueById(deals);
  }
}

/** Nike: its own sale wall, through the API the page itself calls. */
const NIKE_WALL =
  "https://api.nike.com/discover/product_wall/v1/marketplace/FR/language/fr/consumerChannelId/d9a5bc42-4b9c-4976-858a-f159cf99c647?path=/fr/w/promotions-3yaep&attributeIds=5b21a62a-0503-400c-8336-3ccfbff2a684&queryType=PRODUCTS";
const NIKE_PAGES = 6;

export class NikeCollector implements DealSource {
  id = "nike";
  name = "Nike (promotions)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (let page = 0; page < NIKE_PAGES; page++) {
      context?.progress?.("Promotions Nike", page + 1, NIKE_PAGES);
      try {
        deals.push(
          ...parseNikeWall(
            await fetchJson(`${NIKE_WALL}&anchor=${page * 24}&count=24`, {
              headers: {
                "nike-api-caller-id": "com.nike.commerce.nikedotcom.web",
              },
            }),
          ),
        );
      } catch {
        break;
      }
    }
    return uniqueById(deals);
  }
}

/** Foot Locker: sale pages (sneakers from every brand). */
export class FootLockerCollector implements DealSource {
  id = "footlocker";
  name = "Foot Locker (soldes)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const page of [0, 1, 2]) {
      context?.progress?.("Soldes", page + 1, 3);
      try {
        deals.push(
          ...parseFootLockerCards(
            await fetchText(
              `https://www.footlocker.fr/fr/category/sale.html?currentPage=${page}`,
            ),
          ),
        );
      } catch {
        break;
      }
    }
    return uniqueById(deals);
  }
}

/** Castorama: the "offre du moment" pages (DIY, power tools, garden). */
const CASTORAMA_PAGES = [
  "https://www.castorama.fr/bonnes-affaires/offre-du-moment/cat_id_0004552.cat",
  "https://www.castorama.fr/bonnes-affaires/offre-remise/outillage-electroportatif/cat_id_0008701.cat",
  "https://www.castorama.fr/bonnes-affaires/offre-du-moment/jardin/cat_id_0005288.cat",
];

export class CastoramaCollector implements DealSource {
  id = "castorama";
  name = "Castorama (offres du moment)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const [index, url] of CASTORAMA_PAGES.entries()) {
      context?.progress?.(
        "Offres du moment",
        index + 1,
        CASTORAMA_PAGES.length,
      );
      try {
        deals.push(...parseCastoramaTiles(await fetchText(url)));
      } catch {
        // Next page.
      }
    }
    return uniqueById(deals);
  }
}

/**
 * Free-to-keep games outside Epic (Steam, GOG, Ubisoft… and mobile), from
 * GamerPower's public giveaway list, filtered hard (`selectGiveaways`):
 * most giveaways are no-name games nobody would vote for. Each GamerPower
 * link is followed to the store page itself — that's what gets posted.
 */
const STORE_MERCHANTS: Record<string, string> = {
  "steampowered.com": "steam",
  "gog.com": "gog",
  "epicgames.com": "epic",
  "xbox.com": "xbox",
  "playstation.com": "playstation",
};

export class FreeGamesCollector implements DealSource {
  id = "freegames";
  name = "Jeux gratuits (Steam, GOG, Ubisoft, mobile…)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Jeux offerts du moment");
    const giveaways = selectGiveaways(
      (await fetchJson(
        "https://www.gamerpower.com/api/giveaways?type=game",
      )) as GamerPowerGiveaway[],
    );
    const deals: RawDeal[] = [];
    for (const giveaway of giveaways) {
      try {
        const response = await fetch(giveaway.open_giveaway_url, {
          headers: HEADERS,
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        });
        // The store itself may refuse the request (Epic answers 403): its
        // URL, reached through the redirects, is all that's needed.
        if (response.url.includes("gamerpower.com")) continue;
        const storeUrl = new URL(response.url);
        // Land French readers on the French page, not "?lang=en-US".
        storeUrl.searchParams.delete("lang");
        const host = storeUrl.host;
        const merchantId = Object.entries(STORE_MERCHANTS).find(([domain]) =>
          host.endsWith(domain),
        )?.[1];
        deals.push({
          ...giveawayToDeal(giveaway, storeUrl.toString()),
          merchantId,
        });
      } catch {
        // Unreachable link: skip this one.
      }
    }
    return deals;
  }
}

/**
 * Lenovo's own store: laptops on sale ("en vente" filter of its deals
 * page), through the JSON API the page itself calls. Known brand, sold by
 * the maker, with ratings and the spec sheet.
 */
const LENOVO_PAGE_FILTER = "f824452a-3dc8-43a6-8985-ac1673837ce2";
const LENOVO_ON_SALE_FACET = { facetId: "4104", selectedValues: "1" };

export class LenovoCollector implements DealSource {
  id = "lenovo";
  name = "Lenovo (PC portables en promo)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const page of [1, 2]) {
      context?.progress?.("PC portables en promo", page, 2);
      const params = {
        classificationGroupIds: "80001",
        pageFilterId: LENOVO_PAGE_FILTER,
        facets: [LENOVO_ON_SALE_FACET],
        page: String(page),
        pageSize: "40",
        boostsProductCodes: "",
        sorts: ["Recommended"],
      };
      const json = await fetchJson(
        `https://openapi.lenovo.com/fr/fr/ofp/search/dlp/product/query/get/_tsc?pageFilterId=${LENOVO_PAGE_FILTER}&params=${encodeURIComponent(JSON.stringify(params))}`,
        {
          headers: { referer: "https://www.lenovo.com/fr/fr/d/deals/laptops/" },
        },
      );
      const found = parseLenovoProducts(json);
      deals.push(...found);
      if (found.length < 40) break;
    }
    return uniqueById(deals);
  }
}

/** ITJustGood: refurbished laptops of its "Opération spéciale" page. */
export class ItJustGoodCollector implements DealSource {
  id = "itjustgood";
  name = "ITJustGood (PC reconditionnés, opération spéciale)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    const deals: RawDeal[] = [];
    for (const page of [1, 2, 3]) {
      context?.progress?.("Opération spéciale", page, 3);
      const found = parseItJustGoodCards(
        await fetchText(
          `https://www.itjustgood.com/operation-speciale.html${page > 1 ? `?p=${page}` : ""}`,
        ),
      );
      const fresh = found.filter(
        (deal) => !deals.some((d) => d.externalId === deal.externalId),
      );
      // Magento serves the last page again past the end.
      if (fresh.length === 0) break;
      deals.push(...fresh);
    }
    return deals;
  }
}

/**
 * Joybuy: the lightning deals of its /offer page (server-rendered Next.js
 * data). Product pages send automated visitors to a captcha, so only the
 * listing is read; deals are then compared with Amazon/Cdiscount by model.
 */
export class JoybuyCollector implements DealSource {
  id = "joybuy";
  name = "Joybuy (ventes flash)";

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Ventes flash");
    return parseJoybuyOffers(await fetchText("https://www.joybuy.fr/offer"));
  }
}
