import { withBrowser, withPage } from "./browser.ts";
import type { DealSource, DiscoverContext, RawDeal } from "./DealSource.ts";
import {
  parseBouyguesPlans,
  parseByouSeries,
  parseFreePlans,
  parseOrangePromos,
  parseRedPlans,
  parseSoshPlans,
  type TelecomOffer,
} from "./telecomOffers.ts";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { headers: HEADERS });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`);
  }
  return response.text();
}

const KIND_LABEL: Record<TelecomOffer["kind"], string> = {
  mobile: "Forfait mobile",
  box: "Box internet",
  pack: "Pack box + mobile",
};

/**
 * "Forfait mobile RED 40Go", "Orange Pack Internet + mobile": the kind
 * only when the name doesn't already say it, the brand only when the name
 * doesn't already carry it — no "RED by SFR RED 40Go".
 */
export function telecomTitle(offer: TelecomOffer, brand: string): string {
  const name = offer.name.trim();
  const sayskind = /forfait|fibre|box|pack|internet/i.test(name);
  const brandWord = brand.split(" ")[0].toLowerCase();
  const saysBrand =
    name.toLowerCase().includes(brandWord) || /B&YOU/i.test(name);
  return [sayskind ? "" : KIND_LABEL[offer.kind], saysBrand ? "" : brand, name]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ");
}

/**
 * Mobile plans and internet boxes from a telecom operator: what Dealabs'
 * "Forfaits & Box" category is made of. Every operator page/API used here
 * answers a plain `fetch` (no browser), so these also run on Workers.
 *
 * Prices are monthly (`billingPeriod: "month"`). The operator always sells
 * directly, and the struck price is its own normal monthly price — a real
 * former price, trusted as such by the scoring. Phones sold with a plan
 * (« 199 € + 42 €/mois × 24 ») are deliberately left out: they can't be
 * compared with a phone's price anywhere else.
 */
abstract class TelecomCollector implements DealSource {
  abstract id: string;
  abstract name: string;
  /** Operator name as shown in titles ("Orange", "RED by SFR"). */
  protected abstract brand: string;
  protected abstract fetchOffers(): Promise<TelecomOffer[]>;

  async discover(context?: DiscoverContext): Promise<RawDeal[]> {
    context?.progress?.("Lecture des offres forfaits & box");
    const offers = await this.fetchOffers();
    return offers.map((offer) => ({
      externalId: offer.externalId,
      title: telecomTitle(offer, this.brand),
      url: offer.url,
      price: offer.price,
      listPrice: offer.regularPrice,
      description: offer.description,
      currency: "EUR",
      availability: "in_stock",
      merchantId: this.id,
      categoryId: "telecom",
      billingPeriod: "month",
      details: {
        sellerName: this.brand,
        soldByMerchant: true,
        shippedByMerchant: true,
        condition: "new",
        listPriceKind: "regular",
      },
    }));
  }
}

export class OrangeCollector extends TelecomCollector {
  id = "orange";
  name = "Orange (bons plans forfaits & box)";
  protected brand = "Orange";

  protected async fetchOffers() {
    return parseOrangePromos(
      await fetchText("https://boutique.orange.fr/bon-plan-promo/"),
    );
  }
}

export class FreeCollector extends TelecomCollector {
  id = "free";
  name = "Free Mobile (forfaits)";
  protected brand = "Free";

  protected async fetchOffers() {
    const html = await fetchText("https://mobile.free.fr/bons-plans");
    const nextData = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/,
    )?.[1];
    return nextData ? parseFreePlans(JSON.parse(nextData)) : [];
  }
}

export class BouyguesCollector extends TelecomCollector {
  id = "bouygues";
  name = "Bouygues Telecom & B&YOU (forfaits)";
  protected brand = "Bouygues Telecom";

  protected async fetchOffers() {
    // The site's own public search API (no key): every SIM-only plan with
    // its normal and current price. B&YOU's special series aren't in it,
    // but its page states them in plain text.
    const [api, byouPage] = await Promise.all([
      fetch("https://api.bouyguestelecom.fr/search/query/multi-search", {
        method: "POST",
        headers: {
          ...HEADERS,
          "content-type": "application/json",
          origin: "https://www.bouyguestelecom.fr",
        },
        body: JSON.stringify({
          queries: [{ indexUid: "plans", q: "", limit: 100 }],
        }),
      }).then((response) => (response.ok ? response.json() : null)),
      fetchText(
        "https://www.bouyguestelecom.fr/forfaits-mobiles/sans-engagement",
      ).catch(() => ""),
    ]);
    return [...parseBouyguesPlans(api), ...parseByouSeries(byouPage)];
  }
}

export class SfrCollector extends TelecomCollector {
  id = "sfr";
  name = "SFR & RED by SFR (forfaits)";
  protected brand = "RED by SFR";

  protected async fetchOffers() {
    return parseRedPlans(
      await fetchText("https://www.red-by-sfr.fr/forfaits-mobiles/"),
    );
  }
}

/**
 * Sosh (Orange's no-frills brand). Its shop is a client-side app that
 * first bounces through an Orange login cookie check, so — unlike the
 * other operators — it is read in the (local) browser.
 */
export class SoshCollector extends TelecomCollector {
  id = "sosh";
  name = "Sosh (forfaits)";
  protected brand = "Sosh";

  protected async fetchOffers() {
    const text = await withBrowser((browser) =>
      withPage(browser, async (page) => {
        await page.goto("https://shop.sosh.fr/mobile/forfaits-mobiles", {
          waitUntil: "domcontentloaded",
          timeout: 40_000,
        });
        // Plans render client-side: wait for them (Playwright's `text=`
        // selectors don't exist on the Workers browser).
        return page.evaluate(async () => {
          for (let i = 0; i < 40; i++) {
            if (document.body.innerText.includes("par mois")) break;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          return document.body.innerText;
        });
      }),
    );
    return parseSoshPlans(text);
  }
}
