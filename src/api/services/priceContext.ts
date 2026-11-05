import type { DealFacts } from "./dealFacts.ts";
import { PHRASES } from "./descriptionPhrases.ts";

/**
 * The « Repères de prix » lines of a Dealabs description (epic 27, #129).
 *
 * Owner's rule (2026-11-04): a price is written only when it is a real
 * argument and exact. So each line here is one of the score's own price
 * arguments, built from a trusted reference only, dated, and fresh:
 *
 * - a real drop ≥ 20 % vs the shop's legal 30-day low, or vs a regular
 *   price the shop states (Steam, Screwfix, Lidl…) — never a « prix
 *   conseillé », never an unlabelled struck price, never our own history
 *   (Amazon silent drops' usual price is our measurement);
 * - ≥ 10 % under every other shop read in the last 24 h;
 * - under the lowest price already posted on Dealabs (others' posts);
 * - at or under the historical low of a price-history service.
 *
 * No argument, no line; nothing here when the facts are older than their
 * window. Never DealRadar, a score or a chance to heat.
 */

/** A real drop vs a trusted reference, as in the score. */
export const MIN_REAL_DROP = 0.2;
/** Cheaper than the next shop, as in the score. */
export const MIN_SHOP_GAP = 0.1;
/** Other shops' prices older than this are not printed. */
export const SHOP_PRICE_MAX_AGE_H = 24;
/** The shop's own references and the histories, same. */
export const REFERENCE_MAX_AGE_H = 48;

/** Regular prices we measured ourselves, not stated by the shop. */
const MEASURED_REGULAR = new Set(["amazon-watch", "relances"]);

const HOUR = 3_600_000;

/**
 * Shop names for comparisons stored by id (telecom plans compare with
 * other operators' stored plans: « free », « bouygues »).
 */
const SHOP_NAMES: Record<string, string> = {
  free: "Free",
  bouygues: "Bouygues Telecom",
  sfr: "RED by SFR",
  orange: "Orange",
  sosh: "Sosh",
  amazon: "Amazon",
  cdiscount: "Cdiscount",
  aliexpress: "AliExpress",
};

export function shopName(merchant: string): string {
  const known = SHOP_NAMES[merchant.trim().toLowerCase()];
  if (known) return known;
  return /^[a-z]/.test(merchant)
    ? merchant[0].toUpperCase() + merchant.slice(1)
    : merchant;
}

function ageHours(iso: string | undefined, now: number): number | undefined {
  if (!iso) return undefined;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? undefined : (now - at) / HOUR;
}

const fresh = (iso: string | undefined, now: number, maxHours: number) => {
  const age = ageHours(iso, now);
  return age !== undefined && age >= -1 && age <= maxHours;
};

export function euros(value: number, perMonth = false): string {
  const text = Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(".", ",");
  return `${text} €${perMonth ? "/mois" : ""}`;
}

function day(iso: string): string {
  return new Date(iso).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    timeZone: "Europe/Paris",
  });
}

function fullDate(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: "Europe/Paris",
  });
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");
}

const percent = (drop: number) => `${Math.floor(drop * 100)}`;

export function priceContextLines(facts: DealFacts, nowIso: string): string[] {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return [];
  const price = facts.price.current.value;
  if (!(price > 0)) return [];
  const perMonth = facts.price.billingPeriod === "month";
  const merchant = facts.product.merchant?.value ?? "le marchand";
  const lines: string[] = [];

  // 1. Real drop. The 30-day low, when the shop states one, is *the*
  // reference: if it doesn't make a 20 % drop, no other figure is used.
  const low30 = facts.price.lowest30d;
  const listed = facts.price.listed;
  if (low30) {
    const drop = 1 - price / low30.value;
    if (
      drop >= MIN_REAL_DROP &&
      fresh(low30.from.asOf, now, REFERENCE_MAX_AGE_H)
    ) {
      lines.push(
        fill(PHRASES.price.lowest30d, {
          merchant,
          reference: euros(low30.value, perMonth),
          day: day(low30.from.asOf!),
          percent: percent(drop),
        }),
      );
    }
  } else if (
    listed?.value.kind === "regular" &&
    !MEASURED_REGULAR.has(facts.sourceId)
  ) {
    const drop = 1 - price / listed.value.price;
    if (
      drop >= MIN_REAL_DROP &&
      fresh(listed.from.asOf, now, REFERENCE_MAX_AGE_H)
    ) {
      lines.push(
        fill(PHRASES.price.regular, {
          merchant,
          reference: euros(listed.value.price, perMonth),
          day: day(listed.from.asOf!),
          percent: percent(drop),
        }),
      );
    }
  }

  // 2. Other shops, only when we are clearly the cheapest of them all.
  const shops = facts.price.otherShops;
  if (
    shops?.value.length &&
    fresh(shops.from.asOf, now, SHOP_PRICE_MAX_AGE_H) &&
    price <= shops.value[0].price * (1 - MIN_SHOP_GAP)
  ) {
    lines.push(
      fill(PHRASES.price.otherShops, {
        day: day(shops.from.asOf!),
        shops: shops.value
          .slice(0, 3)
          .map(
            (shop) =>
              `${shopName(shop.merchant)} ${euros(shop.price, perMonth)}`,
          )
          .join(", "),
      }),
    );
  }

  // 3. Lower than anyone posted it on Dealabs (our own posts are not in
  // these figures, see DealabsHistoryService).
  const dealabs = facts.price.dealabs;
  const posted = dealabs?.value.lowestPrice;
  if (
    dealabs &&
    posted !== undefined &&
    (dealabs.value.postCount ?? 0) >= 1 &&
    price < posted * 0.99 &&
    fresh(dealabs.from.asOf, now, REFERENCE_MAX_AGE_H)
  ) {
    const at = dealabs.value.lowestAt
      ? fullDate(dealabs.value.lowestAt)
      : undefined;
    lines.push(
      fill(at ? PHRASES.price.dealabsDated : PHRASES.price.dealabs, {
        reference: euros(posted, perMonth),
        date: at ?? "",
      }),
    );
  }

  // 4. Historical low of a price-history service (DekuDeals, ITAD).
  const history = facts.price.historicalLow;
  const source = history?.value.source;
  if (
    history &&
    source &&
    price <= history.value.price * 1.005 &&
    fresh(history.from.asOf, now, REFERENCE_MAX_AGE_H)
  ) {
    const at = history.value.at ? fullDate(history.value.at) : undefined;
    const equal = price >= history.value.price * 0.995;
    lines.push(
      fill(
        equal
          ? PHRASES.price.historicalLowEqual
          : PHRASES.price.historicalLowBelow,
        {
          source,
          reference: euros(history.value.price, perMonth),
          date: at ? ` le ${at}` : "",
        },
      ),
    );
  }
  return lines;
}
