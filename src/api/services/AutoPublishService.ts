import { $env, $inject, type Infer, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { AgentFilesService } from "./AgentFilesService.ts";
import { DealabsDraftService } from "./DealabsDraftService.ts";
import { DealabsHistoryService } from "./DealabsHistoryService.ts";
import {
  DealabsDuplicateError,
  DealabsPublisherService,
} from "./DealabsPublisherService.ts";
import { DealabsSessionService } from "./DealabsSessionService.ts";
import type { DealPageProblem } from "./dealPageCheck.ts";
import { DealPageCheckService } from "./DealPageCheckService.ts";
import type { Deal } from "./DealTypes.ts";
import { keepaChartForDeal } from "./keepa.ts";
import {
  decideAfterRefresh,
  priceChangeText,
  samePrice,
} from "./priceRecheck.ts";
import { PriceSeriesService } from "./PriceSeriesService.ts";
import { PublishPauseService } from "./PublishPauseService.ts";
import {
  PublishCancelledError,
  PublishProgressService,
} from "./PublishProgressService.ts";
import type { PublishTrigger } from "./publishSteps.ts";
import { sameListingKey } from "./sameListing.ts";

type Draft = Infer<typeof dealabsDraftEntity.schema>;

/**
 * The merchant page, opened right before publishing, says the deal can't
 * go out now: site down, product gone or out of stock, price changed.
 * Nothing is sent to Dealabs and nothing is recorded on the draft — the
 * deal may be fine again tomorrow.
 */
export class DealNotAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DealNotAvailableError";
  }
}

/**
 * A publish that is refused before anything is sent to Dealabs (no
 * draft, already posted, another publish running). `status` is the HTTP
 * status the console should see.
 */
export class PublishRefusedError extends Error {
  constructor(
    message: string,
    public readonly status: 404 | 409,
  ) {
    super(message);
    this.name = "PublishRefusedError";
  }
}

/** A deal read again from its shop during a publish (epic 25). */
export interface DealRefresh {
  /** Read through the shop's collector, from the page's stated price, or not. */
  read: "shop" | "page" | "none";
  before: number;
  after?: number;
  /** The deal as stored after the update. */
  deal?: Deal;
  handPicked?: boolean;
  /** Quality gate refused it (the deal was archived). */
  rejected?: string;
  /** Why it couldn't be read. */
  reason?: string;
}

type DealRefresher = (
  dealId: string,
  pagePrice?: number,
) => Promise<DealRefresh>;

export interface AutoPublishOutcome {
  /** Why nothing was attempted at all, when that's the case. */
  skipped?: string;
  published: Array<{ title: string; score: number; url: string }>;
  failed: Array<{ title: string; score: number; reason: string }>;
}

/**
 * Publishes deals to Dealabs: one on demand (the console's « Publication
 * automatique » button), and — right after each collection run — the best
 * new ones on their own, when their score reaches `AUTO_PUBLISH_MIN_SCORE`.
 *
 * The automatic part posts publicly on your account without a click, so it
 * is deliberately conservative:
 * - only deals seen in the run that just finished (never stale ones);
 * - only drafts still "à relire" (not posted, not discarded by you);
 * - one automatic attempt per deal, ever: a failure or a duplicate is
 *   recorded on the draft and left for you to retry by hand, instead of
 *   being retried every 30 minutes;
 * - at most `AUTO_PUBLISH_MAX_PER_RUN` per run, best scores first, and
 *   one per source per run (not three PlayStation games in a row);
 * - at most `AUTO_PUBLISH_MAX_PER_DAY` attempts over the last 24 h: with
 *   ~16 sources and hourly runs, the per-run cap alone would allow ~50
 *   posts a day, which reads as spam on Dealabs;
 * - only where publishing can work at all: the local server, with a saved
 *   Dealabs session.
 * Off by default (end-of-run publishing posts on your account without a
 * review, a spam risk under Dealabs' rules): set `AUTO_PUBLISH=true` to
 * turn it on. The per-deal button works either way.
 */
export class AutoPublishService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected draftService = $inject(DealabsDraftService);
  protected publisher = $inject(DealabsPublisherService);
  protected session = $inject(DealabsSessionService);
  protected dealabsHistory = $inject(DealabsHistoryService);
  protected priceSeries = $inject(PriceSeriesService);
  protected pageCheck = $inject(DealPageCheckService);
  protected progress = $inject(PublishProgressService);
  protected pause = $inject(PublishPauseService);
  protected env = $env(
    z.object({
      AUTO_PUBLISH: z.boolean().default(false),
      /** Deals scoring at least this are published automatically. */
      AUTO_PUBLISH_MIN_SCORE: z.number().default(65),
      AUTO_PUBLISH_MAX_PER_RUN: z.number().default(3),
      AUTO_PUBLISH_MAX_PER_DAY: z.number().default(6),
      /**
       * And at least this estimated chance (%) of reaching 100° on Dealabs
       * (see `heatPrediction.ts`): a good price nobody votes for hurts the
       * account more than it helps.
       */
      AUTO_PUBLISH_MIN_HOT_CHANCE: z.number().default(35),
    }),
  );

  /**
   * Re-reads a deal from its shop (`CollectionService.refreshDeal`, which
   * registers itself here: it already depends on this service).
   */
  protected refreshDeal?: DealRefresher;

  useDealRefresher(refresher: DealRefresher): true {
    this.refreshDeal = refresher;
    return true;
  }

  protected agentFiles = $inject(AgentFilesService);

  /** Thresholds of an automatic publish: the schedule's rules, else ours. */
  protected autoThresholds(trigger: PublishTrigger): {
    minScore: number;
    minHotChance: number;
  } {
    const fallback = {
      minScore: this.env.AUTO_PUBLISH_MIN_SCORE,
      minHotChance: this.env.AUTO_PUBLISH_MIN_HOT_CHANCE,
    };
    if (trigger !== "schedule") return fallback;
    try {
      const rules = JSON.parse(this.agentFiles.readConfig("publish-rules"));
      return {
        minScore: Number(rules.minScore ?? fallback.minScore),
        minHotChance: Number(rules.minHotChance ?? fallback.minHotChance),
      };
    } catch {
      return fallback;
    }
  }

  /**
   * The merchant page shows another price: read the deal again from its
   * shop, store it (price, history, score), then decide whether it can go
   * out at the new price under the rules this publish was started with.
   * Nothing is reported to the publish progress: the schedule's dry run
   * uses it as is.
   */
  async recheckPrice(
    deal: Deal,
    verdict: { reason: string; seenPrice?: number; statedPrice?: number },
    trigger: PublishTrigger,
    /**
     * The page already showed our price: this only confirms it with the
     * shop's own reader. A shop that can't be read then changes nothing.
     */
    confirmOnly = false,
  ): Promise<
    | {
        go: true;
        deal: Deal;
        detail: string;
        priceChange?: { from: number; to: number };
      }
    | { go: false; reason: string }
  > {
    const refresh = this.refreshDeal
      ? await this.refreshDeal(deal.id, verdict.statedPrice)
      : undefined;
    if (!refresh || refresh.read === "none" || !refresh.deal) {
      if (confirmOnly) {
        return {
          go: true,
          deal,
          detail: "Page en ligne, produit disponible au bon prix",
        };
      }
      return {
        go: false,
        reason: `Pas publié : ${verdict.reason} ; deal non mis à jour (${refresh?.reason ?? "relecture indisponible"})`,
      };
    }
    const after = refresh.after ?? refresh.deal.currentPrice;
    const change = priceChangeText(refresh.before, after);
    const now = change.split(" → ")[1];
    if (refresh.rejected) {
      return {
        go: false,
        reason: `Pas publié : prix ${change}, deal mis à jour puis écarté : ${refresh.rejected}`,
      };
    }
    // The shop's own reading must be what the page shows (± 1 %).
    if (
      refresh.read === "shop" &&
      !samePrice(after, refresh.before) &&
      verdict.seenPrice !== undefined &&
      !samePrice(after, verdict.seenPrice) &&
      !(
        verdict.statedPrice !== undefined &&
        samePrice(after, verdict.statedPrice)
      )
    ) {
      return {
        go: false,
        reason: `Pas publié : ${verdict.reason} ; la boutique relue indique ${now} (deal mis à jour, prix à confirmer)`,
      };
    }
    if (samePrice(after, refresh.before)) {
      // The shop still says our price: the page's amount was another one
      // (an accessory, delivery…). Publish as planned.
      return {
        go: true,
        deal: refresh.deal,
        detail: `Prix confirmé par la boutique : ${now}`,
      };
    }
    const duplicate = await this.dealabsHistory
      .findLiveDuplicate(refresh.deal)
      .catch(() => undefined);
    const decision = decideAfterRefresh({
      trigger,
      before: refresh.before,
      after,
      score: refresh.deal.score,
      hotChance: refresh.deal.hotChance,
      handPicked: refresh.handPicked ?? false,
      ...this.autoThresholds(trigger),
      duplicate,
    });
    if (!decision.go) return decision;
    return {
      go: true,
      deal: refresh.deal,
      detail: decision.detail,
      priceChange: { from: refresh.before, to: after },
    };
  }

  /** {@link recheckPrice} inside a publish: reports it, or stops it. */
  protected async followPriceChange(
    deal: Deal,
    verdict: { reason: string; seenPrice?: number; statedPrice?: number },
    trigger: PublishTrigger,
    confirmOnly = false,
  ): Promise<Deal> {
    const outcome = await this.recheckPrice(
      deal,
      verdict,
      trigger,
      confirmOnly,
    );
    if (!outcome.go) throw new DealNotAvailableError(outcome.reason);
    await this.progress.done(
      "merchant-check",
      outcome.detail,
      outcome.priceChange,
    );
    return outcome.deal;
  }

  /** One publish at a time: the button and the run share one browser flow. */
  protected busy = false;

  /** A publish is in progress (button, run or schedule). */
  get isBusy(): boolean {
    return this.busy;
  }

  get enabled(): boolean {
    return this.env.AUTO_PUBLISH;
  }

  get minScore(): number {
    return this.env.AUTO_PUBLISH_MIN_SCORE;
  }

  /**
   * Publishes one deal's draft and records the attempt on it (count, time,
   * result, error) whatever happens. Each phase is reported to
   * {@link PublishProgressService} as it happens, and the run's steps are
   * kept on the draft (`lastPublishSteps`) once it ends.
   * @throws PublishRefusedError when nothing could be attempted,
   *   DealabsDuplicateError when Dealabs already has it, Error otherwise.
   */
  async publishDeal(
    dealId: string,
    trigger: PublishTrigger = "button",
  ): Promise<Draft> {
    if (this.busy) {
      throw new PublishRefusedError(
        "Une publication Dealabs est déjà en cours, réessayez dans un instant.",
        409,
      );
    }
    let draft = await this.drafts.findOne({
      where: { dealId: { eq: dealId } },
    });
    if (!draft) {
      throw new PublishRefusedError(`Pas de brouillon pour ce deal.`, 404);
    }
    // Our own record of having already posted this one — cheap, no browser
    // needed (double click, retry after a flaky run…).
    if (draft.status === "posted") {
      throw new PublishRefusedError(
        draft.dealabsUrl
          ? `Ce deal est déjà publié sur Dealabs : ${draft.dealabsUrl}`
          : "Ce deal est déjà marqué comme publié.",
        409,
      );
    }

    this.busy = true;
    // Set once the attempt counts (something may be sent to Dealabs):
    // pre-flight refusals are not recorded as attempts.
    let attempt:
      | { publishAttempts: number; lastPublishAttemptAt: string }
      | undefined;
    try {
      let deal: Deal = await this.deals.getById(dealId);
      await this.progress.start({ dealId, title: deal.title, trigger });
      await this.progress.done(
        "checks",
        "Brouillon à publier, aucune autre publication en cours",
      );

      // Same product already live on Dealabs (another link, colour or
      // shop) at our price or cheaper: posting it again is a duplicate.
      // Checked before any browser opens; nothing is recorded on the
      // draft — it's still publishable once that deal expires.
      await this.progress.begin("dealabs-duplicate");
      const duplicate = await this.dealabsHistory
        .findLiveDuplicate(deal)
        .catch(() => undefined);
      if (duplicate) {
        throw new DealabsDuplicateError(
          `Déjà en ligne sur Dealabs à ${duplicate.price.toFixed(2).replace(".", ",")} € (${Math.round(duplicate.temperature)}°), pas de republication`,
          duplicate.url,
        );
      }
      await this.progress.done(
        "dealabs-duplicate",
        "Aucun deal identique en ligne",
      );

      // A moderator clicks the link before validating: the merchant page
      // must be up, the product there and still at our price.
      if (this.pageCheck.enabled) {
        await this.progress.begin("merchant-check", deal.url);
        const verdict = await this.pageCheck.check(deal);
        if (!verdict.ok && verdict.problem === "price") {
          deal = await this.followPriceChange(deal, verdict, trigger);
        } else if (!verdict.ok) {
          await this.markUnavailable(deal, verdict.problem);
          throw new DealNotAvailableError(`Pas publié : ${verdict.reason}`);
        } else {
          // Our price is somewhere on the page; the shop's own reader
          // says whether it is the product's (Leclerc's page also shows
          // the cheapest marketplace seller, 2026-11-03).
          deal = await this.followPriceChange(
            deal,
            { reason: "la page affiche notre prix" },
            trigger,
            true,
          );
        }
      } else {
        await this.progress.skip(
          "merchant-check",
          "Vérification désactivée (PUBLISH_PAGE_CHECK=false)",
        );
      }

      // A draft generated while the deal had no description has an empty
      // one: rebuild it from the deal now (never empty, see render()).
      if (!draft.description?.trim()) {
        await this.progress.begin("draft", "Description vide : régénération");
        await this.draftService.maybeGenerateDraft(deal);
        draft =
          (await this.drafts.findOne({ where: { dealId: { eq: dealId } } })) ??
          draft;
        await this.progress.done("draft", "Description régénérée");
      } else {
        await this.progress.done("draft", "Prêt");
      }

      attempt = {
        publishAttempts: (draft.publishAttempts ?? 0) + 1,
        lastPublishAttemptAt: this.dateTime.nowISOString(),
      };

      // Keepa for Amazon (the publisher's default); otherwise the
      // product's eShop history, drawn by QuickChart.
      await this.progress.begin("chart");
      const chart = await this.priceSeries
        .chartImageUrl(deal)
        .catch(() => undefined);
      if (chart) {
        await this.progress.done("chart", "Historique du magasin");
      } else if (keepaChartForDeal(deal)) {
        await this.progress.done("chart", "Courbe Keepa (Amazon)");
      } else {
        await this.progress.skip("chart", "Aucun historique de prix à joindre");
      }

      const { dealabsUrl } = await this.publisher.publish(deal, draft, chart);
      await this.progress.finish(dealabsUrl);
      return await this.drafts.updateById(draft.id, {
        ...attempt,
        lastPublishResult: "success",
        lastPublishError: "",
        lastPublishSteps: this.trail(),
        status: "posted",
        dealabsUrl,
        verifiedAt: this.dateTime.nowISOString(),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Stopped on request: nothing was posted, so it isn't an attempt
      // either — the deal can be published later as if untouched.
      const stopped = error instanceof PublishCancelledError;
      if (stopped) await this.progress.cancel(error);
      else await this.progress.fail(reason);
      await this.drafts
        .updateById(draft.id, {
          ...(attempt && !stopped
            ? {
                ...attempt,
                lastPublishResult:
                  error instanceof DealabsDuplicateError
                    ? ("duplicate" as const)
                    : ("failed" as const),
                lastPublishError: reason.slice(0, 2000),
              }
            : {}),
          lastPublishSteps: this.trail(),
        })
        .catch((saveError) =>
          this.log.warn("Publish trail not saved on the draft", {
            saveError,
          }),
        );
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /**
   * The page says the product is gone or out of stock: the deal says so
   * too, instead of staying listed as active until the next run.
   */
  protected async markUnavailable(
    deal: Deal,
    problem: DealPageProblem | undefined,
  ): Promise<void> {
    const change =
      problem === "gone"
        ? { status: "expired" as const }
        : problem === "out-of-stock"
          ? { availability: "out_of_stock" as const }
          : undefined;
    if (!change) return;
    await this.deals.updateById(deal.id, change).catch((error) =>
      this.log.warn("Deal not marked unavailable", {
        dealId: deal.id,
        error,
      }),
    );
  }

  /** The finished run's steps, as stored on the draft. */
  protected trail(): string | undefined {
    const run = this.progress.snapshot();
    return run ? JSON.stringify(run) : undefined;
  }

  /**
   * After a collection run: publishes the best deals seen since `since`
   * whose score is above the threshold (see the class doc for the rules).
   */
  async publishBestDeals(
    since: string,
    onProgress?: (done: number, total: number) => void,
  ): Promise<AutoPublishOutcome> {
    const outcome: AutoPublishOutcome = { published: [], failed: [] };
    if (!this.enabled) {
      return { ...outcome, skipped: "désactivée (AUTO_PUBLISH=false)" };
    }
    if (this.pause.paused) {
      return { ...outcome, skipped: this.pause.note() };
    }
    const session = this.session.status();
    if (!session.available) {
      return {
        ...outcome,
        skipped: "impossible sur le serveur déployé (navigateur local requis)",
      };
    }
    if (!session.connected) {
      return {
        ...outcome,
        skipped: "pas de session Dealabs (« Se connecter à Dealabs »)",
      };
    }

    const sinceMs = new Date(since).getTime();
    const deals = (
      await this.deals.findMany({
        where: {
          and: [
            { status: { eq: "active" } },
            { score: { gte: this.env.AUTO_PUBLISH_MIN_SCORE } },
          ],
        },
      })
    )
      .filter((deal) => new Date(deal.lastSeenAt).getTime() >= sinceMs)
      .filter(
        (deal) => (deal.hotChance ?? 0) >= this.env.AUTO_PUBLISH_MIN_HOT_CHANCE,
      )
      // Most likely to go hot first, the score breaking ties.
      .sort(
        (a, b) => (b.hotChance ?? 0) - (a.hotChance ?? 0) || b.score - a.score,
      );

    // A colour variant of something already posted (or tried) is the same
    // deal for Dealabs: never post it twice.
    const takenKeys = new Set<string>();
    const handled = await this.drafts.findMany({
      where: { status: { eq: "posted" } },
    });
    const attempted = await this.drafts.findMany({
      where: { publishAttempts: { gte: 1 } },
    });
    for (const draft of [...handled, ...attempted]) {
      const deal = await this.deals.findById(draft.dealId).catch(() => null);
      if (deal) takenKeys.add(sameListingKey(deal));
    }

    const dayAgo = new Date(
      new Date(this.dateTime.nowISOString()).getTime() - 24 * 60 * 60 * 1000,
    ).getTime();
    const attemptsToday = attempted.filter(
      (draft) =>
        draft.lastPublishAttemptAt &&
        new Date(draft.lastPublishAttemptAt).getTime() >= dayAgo,
    ).length;
    const budget = Math.min(
      this.env.AUTO_PUBLISH_MAX_PER_RUN,
      Math.max(0, this.env.AUTO_PUBLISH_MAX_PER_DAY - attemptsToday),
    );
    if (budget === 0) {
      return {
        ...outcome,
        skipped: `limite de ${this.env.AUTO_PUBLISH_MAX_PER_DAY} publications sur 24 h atteinte`,
      };
    }

    const candidates: typeof deals = [];
    const sourcesTaken = new Set<string>();
    for (const deal of deals) {
      if (candidates.length >= budget) break;
      const key = sameListingKey(deal);
      if (takenKeys.has(key) || sourcesTaken.has(deal.sourceId)) continue;
      const draft = await this.draftService.ensureDraftForDeal(deal.id);
      if (draft?.status === "draft" && !draft.publishAttempts) {
        candidates.push(deal);
        takenKeys.add(key);
        sourcesTaken.add(deal.sourceId);
      }
    }

    for (const [index, deal] of candidates.entries()) {
      onProgress?.(index + 1, candidates.length);
      try {
        const draft = await this.publishDeal(deal.id, "collection");
        outcome.published.push({
          title: deal.title,
          score: deal.score,
          url: draft.dealabsUrl ?? "",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log.warn(`Auto-publish failed for "${deal.title}": ${reason}`);
        outcome.failed.push({ title: deal.title, score: deal.score, reason });
        // Someone stopped it: the rest of the batch doesn't start either.
        if (error instanceof PublishCancelledError) break;
      }
    }
    return outcome;
  }
}
