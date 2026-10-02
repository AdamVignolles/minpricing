import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import type { Deal } from "./DealTypes.ts";
import { PricingService, type PriceStats } from "./PricingService.ts";

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
  protected pricing = $inject(PricingService);
  protected dateTime = $inject(DateTimeProvider);

  async maybeGenerateDraft(deal: Deal, stats: PriceStats): Promise<void> {
    const existing = await this.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });

    if (existing?.status === "posted") {
      // Never overwrite a draft you already posted.
      return;
    }

    const { title, body, description } = this.render(deal, stats);

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
    const stats = await this.pricing.getStats(deal.id, deal.currentPrice);
    await this.maybeGenerateDraft(deal, stats);

    return this.drafts.findOne({ where: { dealId: { eq: dealId } } });
  }

  protected render(
    deal: Deal,
    stats: PriceStats,
  ): { title: string; body: string; description: string } {
    const discount =
      stats.avgPrice > 0
        ? Math.round(
            ((stats.avgPrice - deal.currentPrice) / stats.avgPrice) * 100,
          )
        : 0;

    const title = `${deal.title} à ${deal.currentPrice.toFixed(2)} ${deal.currency}${
      discount > 0 ? ` (-${discount}% vs prix moyen)` : ""
    }`;

    // Real, merchant-sourced product info (Amazon feature bullets, Steam's
    // short description, ...) when a collector managed to get one — this is
    // what actually tells a Dealabs reader what the product *is*, instead
    // of DealRadar's own internal bookkeeping.
    const productBlock = deal.description?.trim() || undefined;

    const priceSentence = this.buildPriceSentence(deal, stats);

    // Standalone text for Dealabs' own "Description" field — no title or
    // price repeated, since Dealabs already has dedicated fields for those
    // and shows them next to this text.
    const description = [productBlock, priceSentence]
      .filter((line): line is string => !!line)
      .join("\n\n");

    const bodyLines = [
      `**${deal.title}**`,
      "",
      `Prix actuel : ${deal.currentPrice.toFixed(2)} ${deal.currency}`,
      "",
      ...(productBlock ? [productBlock, ""] : []),
      ...(priceSentence ? [priceSentence, ""] : []),
      `Lien : ${deal.url}`,
    ];

    return { title, body: bodyLines.join("\n"), description };
  }

  /**
   * One natural-language sentence about where the current price sits in
   * the deal's own history — the only "DealRadar-computed" fact worth
   * telling a reader, phrased as a plain claim instead of an internal
   * metric. Omitted entirely when there isn't enough history yet to say
   * anything meaningful.
   */
  protected buildPriceSentence(
    deal: Deal,
    stats: PriceStats,
  ): string | undefined {
    if (stats.historyPoints === 0) {
      return undefined;
    }

    const avg = stats.avgPrice.toFixed(2);
    const max = stats.maxPrice.toFixed(2);
    const currency = deal.currency;

    if (stats.isNewHistoricalMin) {
      return `C'est le prix le plus bas observé depuis le début du suivi (moyenne : ${avg} ${currency}, plus haut relevé : ${max} ${currency}).`;
    }

    const discount =
      stats.avgPrice > 0
        ? Math.round(
            ((stats.avgPrice - deal.currentPrice) / stats.avgPrice) * 100,
          )
        : 0;

    if (discount > 0) {
      return `Environ ${discount}% sous le prix moyen observé (${avg} ${currency}), sans être le plus bas jamais vu (déjà descendu à ${stats.minPrice.toFixed(2)} ${currency}).`;
    }

    return `Prix proche de la moyenne observée (${avg} ${currency}) sur ce produit.`;
  }
}
