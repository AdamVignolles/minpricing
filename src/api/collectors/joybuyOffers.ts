import type { RawDeal } from "./DealSource.ts";

/**
 * Joybuy (JD.com's European store) is a Next.js app: a page's data comes
 * as `self.__next_f.push([1,"…"])` chunks. The /offer page's lightning
 * deals are a flat list in there (`initLightningDataList`).
 *
 * Joybuy labels its struck price « Prix conseillé » (seen on its outlet
 * page), so it is an `rrp`: a Joybuy deal stands out only against other
 * merchants — see the cross-search in `MarketReferenceService`.
 */

const IMAGE_HOST = "https://images4.joy-sourcing.com/joybuyimg/";

interface JoybuyLightning {
  skuId?: number;
  skuIdStr?: string;
  skuName?: string;
  skuImg?: string;
  brandName?: string;
  originalPrice?: number | string | null;
  originalPriceV2?: number | null;
  realPrice?: number | string | null;
  finalPrice?: number | string | null;
  commentScore?: string | null;
  panicbuyingEndTimeText?: string | null;
}

/** The page's streamed Next.js payload, decoded and joined. */
export function nextFlightPayload(html: string): string {
  return [
    ...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g),
  ]
    .map((match) => {
      try {
        return JSON.parse(`"${match[1]}"`) as string;
      } catch {
        return "";
      }
    })
    .join("");
}

/** Every `{"skuId":…,"skuIdStr":…}` object in the payload, parsed. */
function lightningItems(payload: string): JoybuyLightning[] {
  const items: JoybuyLightning[] = [];
  for (const match of payload.matchAll(/\{"skuId":\d+,"skuIdStr"/g)) {
    let depth = 0;
    for (let i = match.index; i < payload.length; i++) {
      const c = payload[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          items.push(JSON.parse(payload.slice(match.index, i + 1)));
        } catch {
          // Not a complete object: skip it.
        }
        break;
      }
    }
  }
  return items;
}

/** "【Offres Avant Black Friday】DJI Mic 3" → "DJI Mic 3". */
export function joybuyTitle(name: string): string {
  return name
    .replace(/【[^】]*】/g, "")
    .replace(/^\s*\[[^\]]*\]\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseJoybuyOffers(html: string): RawDeal[] {
  const seen = new Set<string>();
  return lightningItems(nextFlightPayload(html)).flatMap((item) => {
    const id = item.skuIdStr ?? (item.skuId ? String(item.skuId) : undefined);
    const price = Number(item.finalPrice ?? item.realPrice);
    const list = Number(item.originalPriceV2 ?? item.originalPrice);
    if (!id || !item.skuName || seen.has(id)) return [];
    if (!(price > 0) || !(list > price)) return [];
    seen.add(id);
    return [
      {
        externalId: id,
        title: joybuyTitle(item.skuName),
        url: `https://www.joybuy.fr/dp/${id}`,
        imageUrl: item.skuImg ? `${IMAGE_HOST}${item.skuImg}` : undefined,
        price,
        listPrice: list,
        currency: "EUR",
        availability: "in_stock" as const,
        merchantId: "joybuy",
        description: item.panicbuyingEndTimeText
          ? `- Vente flash Joybuy, jusqu'au ${item.panicbuyingEndTimeText}`
          : undefined,
        details: {
          sellerName: "Joybuy",
          condition: "new" as const,
          listPriceKind: "rrp" as const,
        },
      },
    ];
  });
}

/**
 * The words to search a Joybuy product by on Amazon/Cdiscount: its title
 * starts with the brand ("Midea Bouilloire électrique…", "DJI Mic 3 - 2
 * TX…"), so the first words up to a spec or a separator.
 */
export function joybuyModelQuery(title: string): string | undefined {
  const words: string[] = [];
  for (const word of joybuyTitle(title).split(/\s+/)) {
    if (
      /^[-–|,:]$/.test(word) ||
      /^\d+([.,]\d+)?(cm|mm|w|v|l|go|gb|mah|"|pouces)$/i.test(word)
    )
      break;
    words.push(word.replace(/[,:]$/, ""));
    if (words.length >= 4) break;
  }
  return words.length >= 2 ? words.join(" ") : undefined;
}
