import { load } from "cheerio";

import { type AmazonPageText, parseAmazonSignals } from "./amazonSignals.ts";
import { parsePriceFr } from "./browser.ts";
import type { DealDetails } from "./DealSource.ts";

/** What a product page gives us, whichever way it was read. */
export interface AmazonProductRead {
  price: number;
  listPrice?: number;
  description?: string;
  details?: DealDetails;
  /** Root of the product's breadcrumb, e.g. "Cuisine et Maison". */
  breadcrumb?: string;
  /** `#productTitle`, for a product not found on a listing card. */
  title?: string;
  imageUrl?: string;
}

/** Same selectors, in the same order, as the browser path. */
export const PRICE_SELECTORS = [
  ".priceToPay .a-offscreen",
  ".apex-pricetopay-value .a-offscreen",
  "#corePrice_feature_div .a-price .a-offscreen",
  "#corePriceDisplay_desktop_feature_div .a-price .a-offscreen",
  "#apex_desktop .a-price .a-offscreen",
  "#apex_price .a-offscreen",
];

export const LIST_PRICE_SELECTORS = [
  ".basisPrice .a-offscreen",
  "#corePriceDisplay_desktop_feature_div .a-text-price .a-offscreen",
  "#corePrice_feature_div .a-text-price .a-offscreen",
  'span[data-a-strike="true"] .a-offscreen',
  ".a-price.a-text-price .a-offscreen",
];

const flat = (text: string | undefined) =>
  text?.replace(/\s+/g, " ").trim() || undefined;

/** Amazon's robot check page: no product on it, the browser must retry. */
export function isAmazonChallenge(html: string): boolean {
  return (
    /validateCaptcha|Saisissez les caract|Enter the characters you see|api-services-support@amazon/i.test(
      html,
    ) && !html.includes('id="productTitle"')
  );
}

/**
 * Reads a product page from its server-rendered HTML — the same fields as
 * the browser path (`AmazonCollector.fetchPrice`). Returns `undefined`
 * whenever the page lacks a price or a title: the caller then falls back
 * to the browser rather than guessing.
 */
export function parseAmazonProductHtml(
  html: string,
): AmazonProductRead | undefined {
  if (isAmazonChallenge(html)) return undefined;
  const $ = load(html);
  // What a visitor never reads: `innerText` skips these, `text()` doesn't.
  $("script, style, noscript, .aok-hidden").remove();

  const firstText = (selectors: string[]) => {
    for (const selector of selectors) {
      for (const el of $(selector).toArray()) {
        const text = $(el).text().trim();
        if (text) return text;
      }
    }
    return undefined;
  };
  const text = (selector: string) => flat($(selector).first().text());

  const priceText = firstText(PRICE_SELECTORS);
  const price = priceText ? parsePriceFr(priceText) : undefined;
  const title = text("#productTitle");
  if (price === undefined || !title) return undefined;

  const listPriceText = firstText(LIST_PRICE_SELECTORS);
  const listPrice = listPriceText ? parsePriceFr(listPriceText) : undefined;

  const pageText: AmazonPageText = {
    title,
    priceArea:
      text("#apex_desktop") ??
      text("#corePriceDisplay_desktop_feature_div") ??
      text("#corePrice_feature_div") ??
      "",
    ratingText: $("#acrPopover").first().attr("title") ?? text("#acrPopover"),
    reviewsText: text("#acrCustomerReviewText"),
    sellerText: text(
      "#merchantInfoFeature_feature_div .offer-display-feature-text-message",
    ),
    shipperText: text(
      "#fulfillerInfoFeature_feature_div .offer-display-feature-text-message",
    ),
    buyBoxText: text("#offerDisplayFeatures_desktop"),
    otherSellersText:
      text("#dynamic-aod-ingress-box") ?? text("#olpLinkWidget_feature_div"),
    boughtText: text("#social-proofing-faceout-title-tk_bought"),
    basisText: text(".basisPrice"),
  };

  const image = $("#landingImage, #imgBlkFront").first();
  return {
    price,
    listPrice:
      listPrice !== undefined && listPrice > price ? listPrice : undefined,
    description: bulletsFrom($),
    details: parseAmazonSignals(pageText, price),
    title,
    breadcrumb: flat(
      $("#wayfinding-breadcrumbs_feature_div li a").first().text(),
    ),
    imageUrl: image.attr("data-old-hires") || image.attr("src") || undefined,
  };
}

function bulletsFrom($: ReturnType<typeof load>): string | undefined {
  let items = $("#feature-bullets ul.a-unordered-list li span.a-list-item")
    .toArray()
    .map((el) => flat($(el).text()))
    .filter((t): t is string => !!t && t.length > 3);
  if (items.length === 0) {
    const fallback = flat(
      $("#productDescription p, #productDescription").first().text(),
    );
    items = fallback ? [fallback] : [];
  }
  if (items.length === 0) return undefined;
  const joined = items
    .slice(0, 5)
    .map((line) => `- ${line}`)
    .join("\n");
  return joined.length > 600 ? `${joined.slice(0, 600)}…` : joined;
}

const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "accept-language": "fr-FR,fr;q=0.9",
  accept: "text/html,application/xhtml+xml",
};

/**
 * Plain-HTTP read of a product page. `undefined` means "use the browser":
 * blocked, challenged, or the page didn't hold a price.
 */
export async function fetchAmazonProduct(
  url: string,
  timeoutMs = 20_000,
): Promise<AmazonProductRead | undefined> {
  return (await fetchAmazonProductPage(url, timeoutMs)).product;
}

/** Amazon's « Saisissez les caractères » robot check, in a page's HTML. */
export const isAmazonRobotCheck = (html: string): boolean =>
  /validateCaptcha|Saisissez les caractères que vous voyez/i.test(html);

/** {@link fetchAmazonProduct}, saying whether Amazon showed its robot check. */
export async function fetchAmazonProductPage(
  url: string,
  timeoutMs = 20_000,
): Promise<{ product?: AmazonProductRead; robotCheck: boolean }> {
  try {
    const response = await fetch(url, {
      headers: FETCH_HEADERS,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { robotCheck: response.status === 503 };
    const html = await response.text();
    if (isAmazonRobotCheck(html)) return { robotCheck: true };
    return { product: parseAmazonProductHtml(html), robotCheck: false };
  } catch {
    return { robotCheck: false };
  }
}
