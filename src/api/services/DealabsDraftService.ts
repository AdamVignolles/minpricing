import { $hook, $inject, Alepha } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { merchantEntity } from "../entities/Merchant.ts";
import { DESCRIPTION_TEMPLATE, renderDescription } from "./dealDescription.ts";
import { buildDealFacts } from "./dealFacts.ts";
import { buildDealTitle } from "./dealTitle.ts";
import type { Deal } from "./DealTypes.ts";
import { PHRASES } from "./descriptionPhrases.ts";
import { MIN_VISIBLE_SCORE } from "./ScoringService.ts";

/**
 * Generates (and regenerates) a Dealabs post draft for every deal — no
 * score gate: whether a deal is worth posting is for you to judge from the
 * draft, not something this service should pre-filter. Never publishes
 * anything: the draft stays in "draft" status until you copy it to Dealabs
 * yourself and mark it "posted".
 */
/** What `maybeGenerateDraft` did. */
export type DraftOutcome = "generated" | "agent-edit" | "owner-edit" | "posted";

export class DealabsDraftService {
  protected drafts = $repository(dealabsDraftEntity);
  protected deals = $repository(dealEntity);
  protected merchants = $repository(merchantEntity);
  protected dateTime = $inject(DateTimeProvider);
  protected alepha = $inject(Alepha);
  protected log = $logger();

  /**
   * Roll-out of a new description template (#132): after startup, in the
   * background, the drafts written by an older template (or before
   * templates existed) are rewritten — never a posted or edited one, and
   * only for active visible deals. Runs again on its own whenever
   * `DESCRIPTION_TEMPLATE` is bumped.
   */
  onReady = $hook({
    on: "ready",
    handler: () => {
      if (this.alepha.isTest()) return;
      void this.rollOutTemplate().catch((error: unknown) =>
        this.log.warn("Draft template roll-out failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  /** Rewrites the outdated drafts; returns how many were regenerated. */
  async rollOutTemplate(): Promise<number> {
    const drafts = await this.drafts.findMany({
      where: { status: { eq: "draft" } },
    });
    let done = 0;
    for (const draft of drafts) {
      if (draft.editedAt) continue;
      if (
        draft.templateVersion === DESCRIPTION_TEMPLATE ||
        draft.templateVersion === "legacy"
      ) {
        continue;
      }
      const deal = await this.deals.findById(draft.dealId).catch(() => null);
      if (
        !deal ||
        deal.status !== "active" ||
        (deal.score ?? 0) < MIN_VISIBLE_SCORE
      ) {
        continue;
      }
      if ((await this.maybeGenerateDraft(deal)) === "generated") done++;
    }
    if (done) {
      this.log.info("Drafts regenerated with the new description template", {
        template: DESCRIPTION_TEMPLATE,
        count: done,
      });
    }
    return done;
  }

  /**
   * Writes the draft from the deal's facts. Never overwrites a posted
   * draft, nor one the owner edited (#131). A description written by
   * the selection agent is kept, with its « Repères de prix » rebuilt
   * from today's checked figures and the title regenerated.
   */
  async maybeGenerateDraft(deal: Deal): Promise<DraftOutcome> {
    const existing = await this.drafts.findOne({
      where: { dealId: { eq: deal.id } },
    });

    if (existing?.status === "posted") {
      // Never overwrite a draft you already posted.
      return "posted";
    }
    if (existing?.editedAt && existing.editedBy === "owner") {
      return "owner-edit";
    }

    const merchant = deal.merchantId
      ? await this.merchants.findById(deal.merchantId).catch(() => undefined)
      : undefined;
    const rendered = this.render(deal, merchant?.name);
    const now = this.dateTime.nowISOString();

    if (existing?.editedAt && existing.editedBy?.startsWith("agent:")) {
      const description = withPriceSection(
        stripPriceSection(existing.description ?? ""),
        rendered.priceLines,
      );
      await this.drafts.updateById(existing.id, {
        title: rendered.title,
        description,
        body: postBody(deal, description),
      });
      return "agent-edit";
    }

    const fields = {
      title: rendered.title,
      body: rendered.body,
      description: rendered.description,
      templateVersion: rendered.templateVersion,
      generatedAt: now,
    };
    if (existing) {
      await this.drafts.updateById(existing.id, fields);
    } else {
      await this.drafts.create({ dealId: deal.id, ...fields });
    }
    return "generated";
  }

  /**
   * The owner's own title and/or description (deal page). From then on
   * the draft is never regenerated, until « Régénérer ».
   */
  async editByOwner(
    dealId: string,
    edit: { title?: string; description?: string },
  ) {
    const draft = await this.ensureDraftForDeal(dealId);
    if (!draft) throw new Error(`No draft for deal ${dealId}`);
    const deal = await this.deals.getById(dealId);
    const description = edit.description?.trim() ?? draft.description ?? "";
    return this.drafts.updateById(draft.id, {
      ...(edit.title?.trim() ? { title: edit.title.trim() } : {}),
      description,
      body: postBody(deal, description),
      editedAt: this.dateTime.nowISOString(),
      editedBy: "owner",
    });
  }

  /**
   * The selection agent's own description (`PUT /agent/schedule`, #131).
   * Refused when the owner edited the draft (the owner always wins), when
   * it is posted, or when the text breaks the description rules
   * (`checkAgentDescription`). Returns the reason when refused.
   */
  async editByAgent(
    dealId: string,
    text: string,
    agent: string,
  ): Promise<
    { ok: true; before?: string; after: string } | { ok: false; reason: string }
  > {
    const problem = checkAgentDescription(text);
    if (problem) return { ok: false, reason: problem };
    const draft = await this.ensureDraftForDeal(dealId);
    if (!draft) return { ok: false, reason: "pas de brouillon" };
    if (draft.status === "posted") return { ok: false, reason: "déjà publié" };
    if (draft.editedBy === "owner") {
      return { ok: false, reason: "description modifiée par le propriétaire" };
    }
    const deal = await this.deals.getById(dealId);
    const merchant = deal.merchantId
      ? await this.merchants.findById(deal.merchantId).catch(() => undefined)
      : undefined;
    const rendered = this.render(deal, merchant?.name);
    const description = withPriceSection(text.trim(), rendered.priceLines);
    await this.drafts.updateById(draft.id, {
      description,
      body: postBody(deal, description),
      editedAt: this.dateTime.nowISOString(),
      editedBy: `agent:${agent}`.slice(0, 120),
    });
    return { ok: true, before: draft.description, after: description };
  }

  /** Back to the generated text: clears the edit, then regenerates. */
  async regenerate(dealId: string) {
    const draft = await this.ensureDraftForDeal(dealId);
    if (!draft) throw new Error(`No draft for deal ${dealId}`);
    if (draft.status === "posted") return draft;
    await this.drafts.updateById(draft.id, {
      editedAt: null,
      editedBy: null,
    });
    await this.maybeGenerateDraft(await this.deals.getById(dealId));
    return this.drafts.findOne({ where: { dealId: { eq: dealId } } });
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
   * The post text, built from the deal's facts (`buildDealFacts` →
   * `renderDescription`, epic 27): intro, how to get the price, the
   * merchant's points, specs, the game or plan block, seller and delivery,
   * and what a buyer must know. Only what was read from a source; prices
   * only in « Repères de prix » (#129: trusted, dated, fresh), never
   * DealRadar or a score.
   */
  protected render(
    deal: Deal,
    merchantName?: string,
  ): {
    title: string;
    body: string;
    description: string;
    templateVersion: string;
    /** Today's « Repères de prix » lines, for an agent's text. */
    priceLines: string[];
  } {
    // Dealabs requires a description. When the facts give nothing beyond
    // an intro (product page not read yet), the merchant's text or, last,
    // the title itself: merchant titles list the specs
    // ("… - Moteur 900 W - Batterie 48 V - …").
    const facts = buildDealFacts(deal, { merchantName });
    const rendered = renderDescription(facts, {
      now: this.dateTime.nowISOString(),
    });
    const description =
      rendered?.text ||
      deal.description?.trim() ||
      describeFromTitle(deal.title);
    return {
      // Dealabs-style (#130): type first, platform, « (Vendeur tiers) »…
      title: buildDealTitle(facts),
      body: postBody(deal, description),
      description,
      templateVersion: rendered?.text ? DESCRIPTION_TEMPLATE : "legacy",
      priceLines:
        rendered?.sections.find((section) => section.key === "price")?.lines ??
        [],
    };
  }
}

/** The whole post for « Copier »: bold title, description, link. */
function postBody(deal: Pick<Deal, "title" | "url">, description: string) {
  return [
    `**${deal.title}**`,
    "",
    ...(description ? [description, ""] : []),
    `Lien : ${deal.url}`,
  ].join("\n");
}

/** Description length bounds for an agent's text. */
export const AGENT_DESCRIPTION_MIN = 80;
export const AGENT_DESCRIPTION_MAX = 2200;

/**
 * The rules an agent's description must keep (owner's decision,
 * 2026-11-04): facts only — which the agent is told to do and we can't
 * check —, and what we can check: no DealRadar, no score or heat chance,
 * no price (prices only come from our checked « Repères de prix », put
 * on top of the agent's text), a sane length. French reason when broken.
 */
export function checkAgentDescription(text: string): string | undefined {
  const clean = text.trim();
  if (clean.length < AGENT_DESCRIPTION_MIN) {
    return `description trop courte (${clean.length} caractères, ${AGENT_DESCRIPTION_MIN} au moins)`;
  }
  if (clean.length > AGENT_DESCRIPTION_MAX) {
    return `description trop longue (${clean.length} caractères, ${AGENT_DESCRIPTION_MAX} au plus)`;
  }
  if (/deal\s*radar/i.test(clean)) return "mentionne DealRadar";
  if (
    /\b(score|notre note|note de \d|\d+\s*\/\s*100|chance de (chauffer|buzz)|hot ?chance|potentiel dealabs)\b/i.test(
      clean,
    )
  ) {
    return "mentionne une note ou une chance de chauffer";
  }
  if (/\d\s*(€|euros?\b)|€\s*\d/i.test(clean)) {
    return "contient un prix (les prix viennent seulement des repères vérifiés)";
  }
  if (/<\/?[a-z][^>]*>/i.test(clean)) return "contient du HTML";
  return undefined;
}

/** Drops a leading « Repères de prix : » block. */
function stripPriceSection(text: string): string {
  const title = PHRASES.sections.price;
  if (!text.startsWith(title)) return text;
  const end = text.indexOf("\n\n");
  return end === -1 ? "" : text.slice(end + 2);
}

/** Today's checked price lines on top of an agent's text. */
function withPriceSection(text: string, lines: string[]): string {
  if (!lines.length) return text;
  return [
    [PHRASES.sections.price, ...lines.map((line) => `- ${line}`)].join("\n"),
    text,
  ].join("\n\n");
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

export { DEALABS_TITLE_MAX, dealabsTitle } from "./dealTitle.ts";
