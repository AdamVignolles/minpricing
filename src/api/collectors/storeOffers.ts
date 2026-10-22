import type { RawDeal } from "./DealSource.ts";

/**
 * Pure parsers for the stores read with plain `fetch` (no browser): each
 * turns one store's own JSON (or server-rendered HTML) into `RawDeal`s.
 * Kept apart from the collectors so they can be tested on saved samples.
 *
 * Every store here is the seller itself and its struck price is its own
 * regular price (game stores, Lidl, IKEA), hence `listPriceKind:
 * "regular"` — except where the store says it is a "prix conseillé".
 */

const SELF_SOLD = {
  soldByMerchant: true,
  shippedByMerchant: true,
  condition: "new" as const,
};

/** "€48,99", "48,99 €", "1 049,00 €" → 48.99 / 1049. */
export function parseEuro(text: string | undefined | null): number | undefined {
  if (!text) return undefined;
  const cleaned = text.replace(/[^\d,.]/g, "");
  if (!cleaned) return undefined;
  const normalized = cleaned.includes(",")
    ? cleaned.replace(/\./g, "").replace(",", ".")
    : cleaned;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- Epic

interface EpicElement {
  id: string;
  title: string;
  description?: string;
  productSlug?: string | null;
  urlSlug?: string;
  catalogNs?: { mappings?: Array<{ pageSlug: string }> | null };
  offerMappings?: Array<{ pageSlug: string }> | null;
  keyImages?: Array<{ type: string; url: string }>;
  price?: {
    totalPrice?: { originalPrice: number; discountPrice: number };
  };
  promotions?: {
    promotionalOffers?: Array<{
      promotionalOffers?: Array<{ startDate: string; endDate: string }>;
    }>;
  } | null;
}

/**
 * Epic's weekly free games: only those free *right now* (an active
 * promotion bringing the price to 0), not the "coming next week" ones.
 */
export function parseEpicFreeGames(json: unknown, now = new Date()): RawDeal[] {
  const elements = ((
    json as {
      data?: { Catalog?: { searchStore?: { elements?: EpicElement[] } } };
    }
  ).data?.Catalog?.searchStore?.elements ?? []) as EpicElement[];

  return elements.flatMap((game) => {
    const price = game.price?.totalPrice;
    const offer =
      game.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
    if (!price || !offer || price.discountPrice !== 0) return [];
    if (price.originalPrice <= 0) return [];
    const start = new Date(offer.startDate).getTime();
    const end = new Date(offer.endDate).getTime();
    if (now.getTime() < start || now.getTime() > end) return [];

    const slug =
      game.catalogNs?.mappings?.[0]?.pageSlug ??
      game.offerMappings?.[0]?.pageSlug ??
      game.productSlug?.replace(/\/home$/, "");
    if (!slug) return [];
    const image =
      game.keyImages?.find((img) => img.type === "OfferImageWide") ??
      game.keyImages?.find((img) => img.type === "Thumbnail") ??
      game.keyImages?.[0];

    return [
      {
        externalId: game.id,
        title: `${game.title} (PC, Epic Games Store)`,
        url: `https://store.epicgames.com/fr/p/${slug}`,
        imageUrl: image?.url,
        price: 0,
        listPrice: price.originalPrice / 100,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: "video-games",
        merchantId: "epic",
        description: game.description
          ? `${game.description}\n\nGratuit à récupérer jusqu'au ${new Date(offer.endDate).toLocaleDateString("fr-FR")}, le jeu reste ensuite dans la bibliothèque.`
          : undefined,
        details: {
          ...SELF_SOLD,
          sellerName: "Epic Games Store",
          listPriceKind: "regular" as const,
        },
      },
    ];
  });
}

// ----------------------------------------------------------------- GOG

interface GogProduct {
  id: string;
  slug: string;
  title: string;
  productType?: string;
  coverHorizontal?: string;
  storeLink?: string;
  reviewsRating?: number;
  reviewsCount?: number;
  price?: {
    finalMoney?: { amount: string };
    baseMoney?: { amount: string };
  };
}

/** GOG catalog API (`catalog.gog.com/v1/catalog`), discounted games. */
export function parseGogCatalog(json: unknown): RawDeal[] {
  const products = ((json as { products?: GogProduct[] }).products ??
    []) as GogProduct[];
  return products.flatMap((game) => {
    const price = Number(game.price?.finalMoney?.amount);
    const base = Number(game.price?.baseMoney?.amount);
    if (!Number.isFinite(price) || !Number.isFinite(base) || price >= base) {
      return [];
    }
    return [
      {
        externalId: game.id,
        title: `${game.title} (PC, GOG, sans DRM)`,
        url: game.storeLink ?? `https://www.gog.com/fr/game/${game.slug}`,
        imageUrl: game.coverHorizontal,
        price,
        listPrice: base,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: "video-games",
        merchantId: "gog",
        details: {
          ...SELF_SOLD,
          sellerName: "GOG",
          listPriceKind: "regular" as const,
          // 0-50 on GOG's side.
          productRating: game.reviewsRating
            ? game.reviewsRating / 10
            : undefined,
          productReviewCount: game.reviewsCount || undefined,
        },
      },
    ];
  });
}

// ------------------------------------------------------------ Nintendo

interface NintendoDoc {
  fs_id: string;
  title: string;
  url?: string;
  image_url?: string;
  image_url_h2x1_s?: string;
  price_discounted_f?: number;
  price_regular_f?: number;
  system_names_txt?: string[];
  excerpt?: string;
}

/** Nintendo eShop (EU search index), discounted Switch games. */
export function parseNintendoSearch(json: unknown): RawDeal[] {
  const docs = ((json as { response?: { docs?: NintendoDoc[] } }).response
    ?.docs ?? []) as NintendoDoc[];
  return docs.flatMap((game) => {
    const price = game.price_discounted_f;
    const base = game.price_regular_f;
    if (price === undefined || base === undefined || price >= base) return [];
    if (!game.url) return [];
    const system = game.system_names_txt?.[0] ?? "Nintendo Switch";
    return [
      {
        externalId: game.fs_id,
        title: `${game.title} (${system}, eShop)`,
        url: game.url.startsWith("http")
          ? game.url
          : `https://www.nintendo.com${game.url}`,
        imageUrl: game.image_url_h2x1_s ?? game.image_url,
        price,
        listPrice: base,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: "video-games",
        merchantId: "nintendo",
        description: game.excerpt ? decodeHtml(game.excerpt) : undefined,
        details: {
          ...SELF_SOLD,
          sellerName: "Nintendo eShop",
          listPriceKind: "regular" as const,
        },
      },
    ];
  });
}

// --------------------------------------------------------- PlayStation

interface PsProduct {
  id: string;
  name: string;
  platforms?: string[];
  media?: Array<{ role: string; type: string; url: string }>;
  price?: {
    basePrice?: string;
    discountedPrice?: string;
    discountText?: string | null;
    isTiedToSubscription?: boolean;
    isFree?: boolean;
  };
}

/** PlayStation Store category grid (its own GraphQL API). */
export function parsePlayStationGrid(json: unknown): RawDeal[] {
  const products = ((
    json as {
      data?: { categoryGridRetrieve?: { products?: PsProduct[] } };
    }
  ).data?.categoryGridRetrieve?.products ?? []) as PsProduct[];
  return products.flatMap((game) => {
    const p = game.price;
    // A PS Plus-only price isn't a price everyone gets.
    if (!p?.discountText || p.isTiedToSubscription) return [];
    const price = p.isFree ? 0 : parseEuro(p.discountedPrice);
    const base = parseEuro(p.basePrice);
    if (price === undefined || !base || price >= base) return [];
    const image =
      game.media?.find((m) => m.role === "MASTER" && m.type === "IMAGE") ??
      game.media?.find((m) => m.type === "IMAGE");
    return [
      {
        externalId: game.id,
        title: `${game.name} (${(game.platforms ?? ["PS5"]).join("/")}, PlayStation Store)`,
        url: `https://store.playstation.com/fr-fr/product/${game.id}`,
        imageUrl: image?.url,
        price,
        listPrice: base,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: "video-games",
        merchantId: "playstation",
        details: {
          ...SELF_SOLD,
          sellerName: "PlayStation Store",
          listPriceKind: "regular" as const,
        },
      },
    ];
  });
}

// ---------------------------------------------------------------- Xbox

interface XboxSummary {
  productId: string;
  title: string;
  averageRating?: number;
  ratingCount?: number;
  availableOn?: string[];
  images?: { boxArt?: { url: string }; poster?: { url: string } };
  specificPrices?: {
    purchaseable?: Array<{ listPrice: number; msrp: number }>;
  };
}

/** Xbox Store deals page: the state it embeds (`__PRELOADED_STATE__`). */
export function parseXboxDeals(html: string): RawDeal[] {
  const raw = html.match(
    /window\.__PRELOADED_STATE__ = (\{[\s\S]*?\});\s*(?:window|<\/script>)/,
  )?.[1];
  if (!raw) return [];
  let state: {
    core2?: { products?: { productSummaries?: Record<string, XboxSummary> } };
  };
  try {
    state = JSON.parse(raw);
  } catch {
    return [];
  }
  const summaries = Object.values(
    state.core2?.products?.productSummaries ?? {},
  );
  return summaries.flatMap((game) => {
    const offer = game.specificPrices?.purchaseable?.[0];
    if (!offer || offer.listPrice >= offer.msrp) return [];
    const platform = game.availableOn?.includes("XboxSeriesX")
      ? "Xbox Series"
      : "Xbox";
    return [
      {
        externalId: game.productId,
        title: `${game.title} (${platform}, Xbox Store)`,
        url: `https://www.xbox.com/fr-FR/games/store/p/${game.productId}`,
        imageUrl: game.images?.boxArt?.url ?? game.images?.poster?.url,
        price: offer.listPrice,
        listPrice: offer.msrp,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId: "video-games",
        merchantId: "xbox",
        details: {
          ...SELF_SOLD,
          sellerName: "Microsoft Store",
          listPriceKind: "regular" as const,
          productRating: game.averageRating || undefined,
          productReviewCount: game.ratingCount || undefined,
        },
      },
    ];
  });
}

// ---------------------------------------------------------------- Lidl

interface LidlItem {
  code?: string;
  gridbox?: {
    data?: {
      productId?: number | string;
      fullTitle?: string;
      canonicalUrl?: string;
      image?: string;
      brand?: { name?: string };
      ratings?: { average?: number; count?: number };
      stockAvailability?: { onlineAvailable?: boolean };
      price?: {
        price?: number;
        discount?: {
          deletedPrice?: number;
          percentageDiscount?: number;
          fromRecommendedPrice?: boolean;
          fromNormalPriceForLidlPlus?: boolean;
        };
      };
      keyfacts?: { description?: string };
    };
  };
}

/** Lidl's own search API (`/q/api/search`), one category's items. */
export function parseLidlSearch(json: unknown, categoryId: string): RawDeal[] {
  const items = ((json as { items?: LidlItem[] }).items ?? []) as LidlItem[];
  return items.flatMap((item) => {
    const d = item.gridbox?.data;
    const price = d?.price?.price;
    const discount = d?.price?.discount;
    const list = discount?.deletedPrice;
    if (!d?.fullTitle || !d.canonicalUrl || price === undefined || !list) {
      return [];
    }
    // A price reserved to the Lidl Plus app isn't the shelf price.
    if (price >= list || discount?.fromNormalPriceForLidlPlus) return [];
    if (d.stockAvailability?.onlineAvailable === false) return [];
    const description = d.keyfacts?.description
      ? decodeHtml(d.keyfacts.description.replace(/<[^>]+>/g, " "))
      : undefined;
    return [
      {
        externalId: String(d.productId ?? item.code),
        title: decodeHtml(d.fullTitle),
        url: `https://www.lidl.fr${d.canonicalUrl}`,
        imageUrl: d.image,
        price,
        listPrice: list,
        currency: "EUR",
        availability: "in_stock" as const,
        categoryId,
        merchantId: "lidl",
        description: description || undefined,
        details: {
          ...SELF_SOLD,
          sellerName: "Lidl",
          listPriceKind: discount?.fromRecommendedPrice
            ? ("rrp" as const)
            : ("regular" as const),
          productRating: d.ratings?.average,
          productReviewCount: d.ratings?.count,
        },
      },
    ];
  });
}

// ---------------------------------------------------------------- IKEA

/** IKEA offer page (server-rendered product cards). */
export function parseIkeaOffers(html: string): RawDeal[] {
  return html
    .split('data-product-number="')
    .slice(1)
    .flatMap((card) => {
      const id = card.match(/^([^"]+)"/)?.[1];
      const price = Number(card.match(/data-price="([\d.]+)"/)?.[1]);
      const name = card.match(/data-product-name="([^"]+)"/)?.[1];
      const url = card.match(
        /href="(https:\/\/www\.ikea\.com\/fr\/fr\/p\/[^"]+)"/,
      )?.[1];
      const list = parseEuro(card.match(/Ancien prix ([\d\s.,]+)€/)?.[1]);
      if (!id || !name || !url || !price || !list || price >= list) {
        return [];
      }
      const kind = card
        .match(/plp-price-module__description">([\s\S]*?)<\/span><\/span>/)?.[1]
        ?.replace(/<[^>]+>/g, " ");
      const rating = card.match(/Révision: ([\d.]+) hors de 5/)?.[1];
      const count = card.match(/rating-label-count">\((\d+)\)/)?.[1];
      return [
        {
          externalId: id,
          title: decodeHtml(`IKEA ${decodeHtml(name)} ${kind ?? ""}`),
          url,
          imageUrl: card
            .match(/<img[^>]*src="([^"]+)"/)?.[1]
            ?.replace(/\?f=\w+$/, "?f=s"),
          price,
          listPrice: list,
          currency: "EUR",
          availability: "in_stock" as const,
          categoryId: "home",
          merchantId: "ikea",
          details: {
            ...SELF_SOLD,
            sellerName: "IKEA",
            listPriceKind: "regular" as const,
            productRating: rating ? Number(rating) : undefined,
            productReviewCount: count ? Number(count) : undefined,
          },
        },
      ];
    });
}

// ---------------------------------------------------------- GamerPower

export interface GamerPowerGiveaway {
  id: number;
  title: string;
  worth: string;
  image?: string;
  thumbnail?: string;
  description?: string;
  open_giveaway_url: string;
  type: string;
  platforms: string;
  end_date?: string;
}

/** Stores whose free games are worth a post (Epic has its own source). */
const GIVEAWAY_PC_STORES =
  /\b(Steam|GOG|Ubisoft|EA Origin|EA App|Battle\.net|Xbox|PlayStation)\b/i;
/** Giveaway platforms of no-name games or that need an account elsewhere. */
const GIVEAWAY_EXCLUDED = /IndieGala|Stove|Itch\.io|\bVR\b|Rift|DRM-Free/i;
const MIN_WORTH_PC = 9.99;
const MIN_WORTH_MOBILE = 4.99;

/**
 * GamerPower's public giveaway list, cut down to the free games people
 * actually want: full games (no DLC/loot), from a real store, worth a few
 * euros at least, no "key giveaways" that make you sign up on a third-party
 * site. The link is still GamerPower's: the collector resolves it.
 */
export function selectGiveaways(
  giveaways: GamerPowerGiveaway[],
): GamerPowerGiveaway[] {
  return giveaways.filter((g) => {
    if (g.type !== "Game" || /key giveaway/i.test(g.title)) return false;
    if (GIVEAWAY_EXCLUDED.test(`${g.platforms} ${g.title}`)) return false;
    if (
      /Epic Games Store/i.test(g.platforms) &&
      !/Android|iOS/i.test(g.platforms)
    ) {
      return false;
    }
    const worth = parseEuro(g.worth) ?? 0;
    if (/Android|iOS/i.test(g.platforms)) return worth >= MIN_WORTH_MOBILE;
    return GIVEAWAY_PC_STORES.test(g.platforms) && worth >= MIN_WORTH_PC;
  });
}

/** "TerraScape (Epic Games) Giveaway" → "TerraScape". */
export function giveawayGameName(title: string): string {
  return title
    .replace(/\s+(Key\s+)?Giveaway$/i, "")
    .replace(/\s+\([^)]*\)$/, "")
    .trim();
}

export function giveawayToDeal(
  g: GamerPowerGiveaway,
  storeUrl: string,
): RawDeal {
  const mobile = /Android|iOS/i.test(g.platforms);
  const platform = mobile
    ? g.platforms.replace(/,\s*/g, "/")
    : (g.platforms.match(GIVEAWAY_PC_STORES)?.[0] ?? "PC");
  const until =
    g.end_date && g.end_date !== "N/A"
      ? ` jusqu'au ${new Date(g.end_date.replace(" ", "T")).toLocaleDateString("fr-FR")}`
      : "";
  return {
    externalId: String(g.id),
    title: `${giveawayGameName(g.title)} gratuit (${mobile ? platform : `PC, ${platform}`})`,
    url: storeUrl,
    imageUrl: g.image ?? g.thumbnail,
    price: 0,
    // GamerPower's "worth" is the game's usual store price (in $, close
    // enough to the € price for a reference).
    listPrice: parseEuro(g.worth),
    currency: "EUR",
    availability: "in_stock",
    categoryId: "video-games",
    description: [
      g.description?.trim(),
      `Gratuit à récupérer${until}, le jeu reste ensuite dans la bibliothèque.`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    details: {
      soldByMerchant: true,
      shippedByMerchant: true,
      condition: "new",
      listPriceKind: "regular",
    },
  };
}
