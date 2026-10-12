import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import type { Deal } from "./DealTypes.ts";

/**
 * Generates (and regenerates) a Dealabs post draft for every deal — no
 * score gate: whether a deal is worth posting is for you to judge from the
 * draft, not something this service should pre-filter. Never publishes
 * anything: the draft stays in "draft" status until you copy it to Dealabs
 * yourself and mark it "posted".
 */
export class DealabsDraftService {
  protected drafts = $repository(dealabsDraftEntity);
  protected deals = $repository(dealEntity);
  protected dateTime = $inject(DateTimeProvider);

  async maybeGenerateDraft(deal: Deal): Promise<void> {
    const existing = await this.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });

    if (existing?.status === "posted") {
      // Never overwrite a draft you already posted.
      return;
    }

    const { title, body, description } = this.render(deal);

    if (existing) {
      await this.drafts.updateById(existing.id, {
        title,
        body,
        description,
        generatedAt: this.dateTime.nowISOString(),
      });
    } else {
      await this.drafts.create({
        dealId: deal.id,
        title,
        body,
        description,
        generatedAt: this.dateTime.nowISOString(),
      });
    }
  }

  /**
   * Generates the draft for a deal that already exists in the DB but has
   * never been through the collection pipeline since this feature shipped
   * (or was added before the score gate was removed). Lets the console
   * backfill a draft on first view instead of waiting for the next cron run.
   */
  async ensureDraftForDeal(dealId: string) {
    const existing = await this.drafts.findOne({
      where: { dealId: { eq: dealId } },
    });
    if (existing) {
      return existing;
    }

    const deal = await this.deals.getById(dealId);
    await this.maybeGenerateDraft(deal);

    return this.drafts.findOne({ where: { dealId: { eq: dealId } } });
  }

  /**
   * The post text. No price anywhere — not the current one, not an
   * average, not "lowest since we started tracking": Dealabs has its own
   * price fields and shows them next to the post, and our internal
   * statistics (a handful of observations) mean nothing to a reader. What
   * goes in is what the product *is*: the merchant's own description
   * (Amazon feature bullets, Cdiscount strengths and specs, Steam store
   * facts).
   */
  protected render(deal: Deal): {
    title: string;
    body: string;
    description: string;
  } {
    // Dealabs requires a description. Without a merchant one (product page
    // not read yet), the title itself is factual product info: merchant
    // titles list the specs ("… - Moteur 900 W - Batterie 48 V - …").
    const description =
      deal.description?.trim() || describeFromTitle(deal.title);
    const bodyLines = [
      `**${deal.title}**`,
      "",
      ...(description ? [description, ""] : []),
      `Lien : ${deal.url}`,
    ];
    return {
      title: dealabsTitle(deal.title),
      body: bodyLines.join("\n"),
      description,
    };
  }
}

/**
 * Turns a spec-laden merchant title into a short description: the product
 * name, then one bullet per spec. "OOTD T10 - Trottinette électrique
 * pliable - Moteur 900 W - Batterie 48 V" →
 * "OOTD T10 - Trottinette électrique pliable\n- Moteur 900 W\n- Batterie 48 V".
 */
export function describeFromTitle(title: string): string {
  const parts = title
    .split(/\s[-–—|]\s|,\s/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length <= 2) {
    return title.trim();
  }
  const [brand, name, ...specs] = parts;
  return [`${brand} - ${name}`, ...specs.map((spec) => `- ${spec}`)].join("\n");
}

/** Dealabs refuses titles longer than this. */
export const DEALABS_TITLE_MAX = 140;

/**
 * Fits a merchant title into Dealabs' 140 characters without cutting a
 * word in half: whole trailing segments ("…, avec prise en charge du
 * Wi-Fi 6", "– Clavier AZERTY") are dropped first, and only a single
 * over-long segment is cut, at a word boundary.
 */
export function dealabsTitle(title: string, max = DEALABS_TITLE_MAX): string {
  const clean = title.replace(/\s+/g, " ").trim();
  if (clean.length <= max) {
    return clean;
  }
  // Split points that end a meaningful part of a product title.
  const cuts = [...clean.matchAll(/\s[-–—|]\s|,\s|\s\(|:\s/g)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined && index <= max);
  const lastCut = cuts.at(-1);
  if (lastCut !== undefined && lastCut >= max * 0.4) {
    return clean.slice(0, lastCut).trim();
  }
  const words = clean.slice(0, max + 1).split(" ");
  words.pop();
  return words.join(" ").replace(/[\s,;:–—-]+$/, "");
}
