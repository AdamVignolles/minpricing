import { $env, $inject, type Infer, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { DealabsDraftService } from "./DealabsDraftService.ts";
import {
  DealabsDuplicateError,
  DealabsPublisherService,
} from "./DealabsPublisherService.ts";
import { DealabsSessionService } from "./DealabsSessionService.ts";

type Draft = Infer<typeof dealabsDraftEntity.schema>;

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
 * - at most `AUTO_PUBLISH_MAX_PER_RUN` per run, best scores first;
 * - only where publishing can work at all: the local server, with a saved
 *   Dealabs session.
 * Set `AUTO_PUBLISH=false` to turn it off.
 */
export class AutoPublishService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected deals = $repository(dealEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected draftService = $inject(DealabsDraftService);
  protected publisher = $inject(DealabsPublisherService);
  protected session = $inject(DealabsSessionService);
  protected env = $env(
    z.object({
      AUTO_PUBLISH: z.boolean().default(true),
      /** Deals scoring at least this are published automatically. */
      AUTO_PUBLISH_MIN_SCORE: z.number().default(65),
      AUTO_PUBLISH_MAX_PER_RUN: z.number().default(3),
    }),
  );

  /** One publish at a time: the button and the run share one browser flow. */
  protected busy = false;

  get enabled(): boolean {
    return this.env.AUTO_PUBLISH;
  }

  get minScore(): number {
    return this.env.AUTO_PUBLISH_MIN_SCORE;
  }

  /**
   * Publishes one deal's draft and records the attempt on it (count, time,
   * result, error) whatever happens.
   * @throws PublishRefusedError when nothing could be attempted,
   *   DealabsDuplicateError when Dealabs already has it, Error otherwise.
   */
  async publishDeal(dealId: string): Promise<Draft> {
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
    try {
      const deal = await this.deals.getById(dealId);
      // A draft generated while the deal had no description has an empty
      // one: rebuild it from the deal now (never empty, see render()).
      if (!draft.description?.trim()) {
        await this.draftService.maybeGenerateDraft(deal);
        draft =
          (await this.drafts.findOne({ where: { dealId: { eq: dealId } } })) ??
          draft;
      }
      const attempt = {
        publishAttempts: (draft.publishAttempts ?? 0) + 1,
        lastPublishAttemptAt: this.dateTime.nowISOString(),
      };

      try {
        const { dealabsUrl } = await this.publisher.publish(deal, draft);
        return await this.drafts.updateById(draft.id, {
          ...attempt,
          lastPublishResult: "success",
          lastPublishError: "",
          status: "posted",
          dealabsUrl,
          verifiedAt: this.dateTime.nowISOString(),
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.drafts.updateById(draft.id, {
          ...attempt,
          lastPublishResult:
            error instanceof DealabsDuplicateError ? "duplicate" : "failed",
          lastPublishError: reason.slice(0, 2000),
        });
        throw error;
      }
    } finally {
      this.busy = false;
    }
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
      .sort((a, b) => b.score - a.score);

    const candidates: typeof deals = [];
    for (const deal of deals) {
      if (candidates.length >= this.env.AUTO_PUBLISH_MAX_PER_RUN) break;
      const draft = await this.draftService.ensureDraftForDeal(deal.id);
      if (draft?.status === "draft" && !draft.publishAttempts) {
        candidates.push(deal);
      }
    }

    for (const [index, deal] of candidates.entries()) {
      onProgress?.(index + 1, candidates.length);
      try {
        const draft = await this.publishDeal(deal.id);
        outcome.published.push({
          title: deal.title,
          score: deal.score,
          url: draft.dealabsUrl ?? "",
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.log.warn(`Auto-publish failed for "${deal.title}": ${reason}`);
        outcome.failed.push({ title: deal.title, score: deal.score, reason });
      }
    }
    return outcome;
  }
}
