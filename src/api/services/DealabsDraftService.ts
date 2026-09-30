import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import type { Deal } from "./DealTypes.ts";
import type { PriceStats } from "./PricingService.ts";

/**
 * Minimum score for a deal to be worth drafting as a Dealabs post.
 */
export const DRAFT_SCORE_THRESHOLD = 50;

/**
 * Generates (and regenerates) a Dealabs post draft for a deal. Never
 * publishes anything: the draft stays in "draft" status until you copy it
 * to Dealabs yourself and mark it "posted".
 */
export class DealabsDraftService {
  protected drafts = $repository(dealabsDraftEntity);
  protected dateTime = $inject(DateTimeProvider);

  async maybeGenerateDraft(deal: Deal, stats: PriceStats): Promise<void> {
    if (deal.score < DRAFT_SCORE_THRESHOLD) {
      return;
    }

    const existing = await this.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });

    if (existing?.status === "posted") {
      // Never overwrite a draft you already posted.
      return;
    }

    const { title, body } = this.render(deal, stats);

    if (existing) {
      await this.drafts.updateById(existing.id, {
        title,
        body,
        generatedAt: this.dateTime.nowISOString(),
      });
    } else {
      await this.drafts.create({
        dealId: deal.id,
        title,
        body,
        generatedAt: this.dateTime.nowISOString(),
      });
    }
  }

  protected render(
    deal: Deal,
    stats: PriceStats,
  ): { title: string; body: string } {
    const discount =
      stats.avgPrice > 0
        ? Math.round(
            ((stats.avgPrice - deal.currentPrice) / stats.avgPrice) * 100,
          )
        : 0;

    const title = `${deal.title} à ${deal.currentPrice.toFixed(2)} ${deal.currency}${
      discount > 0 ? ` (-${discount}% vs prix moyen)` : ""
    }`;

    const bodyLines = [
      `**${deal.title}**`,
      "",
      `Prix actuel : ${deal.currentPrice.toFixed(2)} ${deal.currency}`,
      stats.minPrice < deal.currentPrice
        ? undefined
        : `Plus bas prix jamais observé (min historique : ${stats.minPrice.toFixed(2)} ${deal.currency}).`,
      `Prix moyen observé : ${stats.avgPrice.toFixed(2)} ${deal.currency}`,
      `Score de pertinence : ${deal.score}/100`,
      "",
      `Lien : ${deal.url}`,
    ].filter((line): line is string => line !== undefined);

    return { title, body: bodyLines.join("\n") };
  }
}
