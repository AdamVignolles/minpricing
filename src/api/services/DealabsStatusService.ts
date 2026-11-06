import { $inject, Alepha, type Infer } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { DealabsDraftService } from "./DealabsDraftService.ts";
import { DealabsHistoryService } from "./DealabsHistoryService.ts";
import type { DealabsThread } from "./dealabsSearch.ts";
import {
  currentDealabsStatus,
  type DealabsStatus,
  type DealabsStatusChange,
  type DealabsStatusSource,
  dealabsThreadId,
  matchProfilePosts,
  type PostedBy,
  profileStatus,
  readHistory,
  statusSummaryLine,
  threadPageStatus,
  withChange,
} from "./dealabsStatus.ts";
import { MyDealabsPostsService } from "./MyDealabsPostsService.ts";

type Draft = Infer<typeof dealabsDraftEntity.schema>;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};
/** The run's check happens at most this often. */
const RUN_EVERY_MS = 60 * 60_000;
/** Post pages read per check (paced), oldest-checked first. */
const THREADS_PER_RUN = 20;
/** Deals considered for a post published by hand. */
const MANUAL_MATCH_DAYS = 45;

export interface StatusCheckSummary {
  live: number;
  expired: number;
  hidden: number;
  deleted: number;
  /** Posts published by hand, attached to their deal in this check. */
  attached: number;
  changes: number;
  /** Drafts whose answer was unreadable (status kept). */
  unreadable: number;
  /** Why nothing was checked, when that's the case. */
  skipped?: string;
  line: string;
}

/** One deal's status, as the deal page shows it. */
export interface DealDealabsStatus {
  status: DealabsStatus;
  label?: string;
  url?: string;
  temperature?: number;
  postPrice?: number;
  checkedAt?: string;
  statusAt?: string;
  source?: string;
  postedBy?: string;
  history: DealabsStatusChange[];
  /** Someone else's live post for the product, from a fresh search. */
  othersLive?: { url: string; price: number; temperature: number };
  /** Why the check couldn't conclude, when it couldn't. */
  note?: string;
}

/**
 * Checks back what became of our Dealabs posts (epic 32): our public
 * profile (live / expired), then each post missing from it on its own
 * page (gone = deleted, awaiting moderation = hidden), and attaches posts
 * published by hand to their deal. Paced with the app-wide Dealabs limit;
 * an unreadable answer never changes a status. Run at the end of each
 * collection (at most hourly) and from the deal page.
 */
export class DealabsStatusService {
  protected log = $logger();
  protected alepha = $inject(Alepha);
  protected dateTime = $inject(DateTimeProvider);
  protected drafts = $repository(dealabsDraftEntity);
  protected deals = $repository(dealEntity);
  protected myPosts = $inject(MyDealabsPostsService);
  protected history = $inject(DealabsHistoryService);
  protected draftService = $inject(DealabsDraftService);

  protected lastRunAt = 0;
  protected running?: Promise<StatusCheckSummary>;

  /**
   * Records a status on a draft: the change goes to its history, and a
   * post that became hidden or deleted raises the moderation alert
   * (epic 29's banner) unless one is already up.
   */
  async setStatus(
    draft: Draft,
    status: DealabsStatus,
    source: DealabsStatusSource,
    extra: {
      url?: string;
      temperature?: number;
      postPrice?: number;
      postedBy?: PostedBy;
      message?: string;
    } = {},
  ): Promise<boolean> {
    const now = this.dateTime.nowISOString();
    const before = currentDealabsStatus(draft);
    const changed = before !== status || !draft.dealabsStatus;
    const patch: Partial<Draft> & Record<string, unknown> = {
      dealabsStatus: status,
      dealabsCheckedAt: now,
      dealabsStatusSource: source,
      ...(extra.temperature !== undefined
        ? { dealabsTemperature: Math.round(extra.temperature) }
        : {}),
      ...(extra.postPrice !== undefined
        ? { dealabsPostPrice: extra.postPrice }
        : {}),
      ...(extra.postedBy ? { postedBy: extra.postedBy } : {}),
    };
    if (changed) {
      patch.dealabsStatusAt = now;
      patch.dealabsStatusHistory = withChange(draft.dealabsStatusHistory, {
        at: now,
        from: draft.dealabsStatus ? before : undefined,
        to: status,
        source,
        url: extra.url ?? draft.dealabsUrl ?? undefined,
        temperature: extra.temperature,
      });
    }
    if (
      (status === "hidden" || status === "deleted") &&
      draft.moderationStatus !== status
    ) {
      patch.moderationStatus = status;
      patch.moderationAt = draft.moderationAt ?? now;
      patch.moderationReason = draft.moderationReason ?? "other";
      patch.moderationMessage =
        draft.moderationMessage ??
        extra.message ??
        (status === "deleted"
          ? "Le post n'existe plus sur Dealabs."
          : "Le post est masqué (en attente de modération).");
      patch.moderationDismissedAt = null as unknown as undefined;
    }
    if (status === "live" && draft.moderationStatus === "hidden") {
      patch.moderationStatus = "ok";
    }
    await this.drafts.updateById(draft.id, patch as Partial<Draft>);
    if (changed && draft.dealabsStatus) {
      this.log.info("Dealabs status changed", {
        dealId: draft.dealId,
        from: before,
        to: status,
        source,
      });
    }
    return changed && !!draft.dealabsStatus;
  }

  /** At the end of a run: the check, unless one ran less than an hour ago. */
  async checkIfDue(): Promise<StatusCheckSummary | undefined> {
    if (Date.now() - this.lastRunAt < RUN_EVERY_MS) return undefined;
    return this.checkAll();
  }

  /** The whole check (concurrent calls share it). */
  checkAll(): Promise<StatusCheckSummary> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  protected async run(): Promise<StatusCheckSummary> {
    const counts = {
      live: 0,
      expired: 0,
      hidden: 0,
      deleted: 0,
      attached: 0,
      changes: 0,
      unreadable: 0,
    };
    if (this.alepha.isServerless()) {
      return { ...counts, skipped: "serverless", line: "" };
    }
    this.lastRunAt = Date.now();
    const posts = await this.myPosts.postsFresh().catch(() => undefined);
    const drafts = await this.drafts.findMany({});
    const touched = new Set<string>();

    if (posts) {
      await this.applyProfile(posts, drafts, counts, touched);
    }

    // Posted drafts the profile didn't confirm: their own page decides.
    const fresh = await this.drafts.findMany({
      where: { status: { eq: "posted" } },
    });
    const toRead = fresh
      .filter((draft) => !touched.has(draft.id))
      .sort((a, b) =>
        (a.dealabsCheckedAt ?? "").localeCompare(b.dealabsCheckedAt ?? ""),
      )
      .slice(0, THREADS_PER_RUN);
    for (const draft of toRead) {
      const status = await this.readThread(draft);
      if (!status) {
        counts.unreadable++;
        continue;
      }
      if (await this.setStatus(draft, status, "thread")) counts.changes++;
    }

    for (const draft of await this.drafts.findMany({
      where: { status: { eq: "posted" } },
    })) {
      const status = currentDealabsStatus(draft);
      if (status in counts) counts[status as keyof typeof counts]++;
    }
    const line = posts
      ? statusSummaryLine(counts)
      : `Dealabs : profil illisible, statuts inchangés (${counts.changes} changement(s) par les pages des posts)`;
    this.log.info(line);
    return { ...counts, line };
  }

  /** Profile posts matched to drafts, posts published by hand attached. */
  protected async applyProfile(
    posts: DealabsThread[],
    drafts: Draft[],
    counts: { attached: number; changes: number },
    touched: Set<string>,
  ): Promise<void> {
    const since = new Date(
      new Date(this.dateTime.nowISOString()).getTime() -
        MANUAL_MATCH_DAYS * 24 * 3600_000,
    ).toISOString();
    const recentDeals = await this.deals.findMany({
      where: { lastSeenAt: { gte: since } },
    });
    const draftById = new Map(drafts.map((draft) => [draft.id, draft]));
    for (const match of matchProfilePosts(posts, drafts, recentDeals)) {
      let draft = match.draftId ? draftById.get(match.draftId) : undefined;
      if (!draft && match.dealId) {
        // A post published by hand for a deal without a draft yet.
        draft =
          (await this.draftService
            .ensureDraftForDeal(match.dealId)
            .catch(() => undefined)) ?? undefined;
      }
      if (!draft) continue;
      const status = profileStatus(match.post);
      if (draft.status !== "posted" || !dealabsThreadId(draft.dealabsUrl)) {
        // Posted by hand (or our link was never stored): it is ours now,
        // and the agents won't publish it again while it is live.
        const attachedByHand = draft.status !== "posted";
        draft = (await this.drafts.updateById(draft.id, {
          status: "posted",
          dealabsUrl: match.post.url,
          verifiedAt: this.dateTime.nowISOString(),
          ...(attachedByHand ? { postedBy: "manual" } : {}),
        })) as Draft;
        if (attachedByHand) counts.attached++;
      }
      touched.add(draft.id);
      if (
        await this.setStatus(draft, status, "profile", {
          url: match.post.url,
          temperature: match.post.temperature,
          postPrice: match.post.price,
        })
      ) {
        counts.changes++;
      }
    }
  }

  /** A post's page, anonymously, at the app's Dealabs pace. */
  protected async readThread(
    draft: Pick<Draft, "dealabsUrl" | "moderationStatus">,
  ): Promise<DealabsStatus | undefined> {
    const threadId = dealabsThreadId(draft.dealabsUrl);
    if (!threadId || !draft.dealabsUrl) return undefined;
    try {
      await this.history.waitForSlot();
      const response = await fetch(draft.dealabsUrl, {
        headers: HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      const html = response.ok ? await response.text() : "";
      const status = threadPageStatus({
        status: response.status,
        finalUrl: response.url,
        html,
        threadId,
      });
      // Gone for a visitor: a moderator's message may already say it is
      // only hidden (epic 29), which is the more precise reading.
      if (status === "deleted" && draft.moderationStatus === "hidden") {
        return "hidden";
      }
      return status;
    } catch {
      return undefined;
    }
  }

  /** « Vérifier sur Dealabs » on the deal page: this deal, now. */
  async checkDeal(dealId: string): Promise<DealDealabsStatus> {
    const deal = await this.deals.getById(dealId);
    let draft = await this.drafts.findOne({
      where: { dealId: { eq: dealId } },
    });
    let note: string | undefined;
    const posts = await this.myPosts.postsFresh().catch(() => undefined);
    if (posts && draft) {
      const counts = { attached: 0, changes: 0 };
      const touched = new Set<string>();
      const others = await this.drafts.findMany({});
      await this.applyProfile(
        posts,
        others.filter(
          (row) => row.dealId === dealId || dealabsThreadId(row.dealabsUrl),
        ),
        counts,
        touched,
      );
      draft = await this.drafts.findOne({ where: { dealId: { eq: dealId } } });
      if (draft && !touched.has(draft.id) && draft.status === "posted") {
        const status = await this.readThread(draft);
        if (status) await this.setStatus(draft, status, "thread");
        else note = "page du post illisible : statut inchangé";
      }
    } else if (!posts) {
      note = "profil Dealabs illisible (ou DEALABS_USERNAME absent)";
      if (draft?.status === "posted") {
        const status = await this.readThread(draft);
        if (status) await this.setStatus(draft, status, "thread");
      }
    }
    const othersLive = await this.history
      .findLiveDuplicate(deal)
      .catch(() => undefined);
    draft = await this.drafts.findOne({ where: { dealId: { eq: dealId } } });
    return {
      ...this.describe(draft ?? undefined),
      ...(othersLive && !(posts ?? []).some((post) => post.id === othersLive.id)
        ? {
            othersLive: {
              url: othersLive.url,
              price: othersLive.price,
              temperature: Math.round(othersLive.temperature),
            },
          }
        : {}),
      ...(note ? { note } : {}),
    };
  }

  /** The stored status of one draft, as the deal page shows it. */
  describe(draft: Draft | undefined): DealDealabsStatus {
    if (!draft) return { status: "not_published", history: [] };
    const history = readHistory(draft.dealabsStatusHistory);
    return {
      status: currentDealabsStatus(draft),
      url: draft.dealabsUrl ?? undefined,
      temperature: draft.dealabsTemperature ?? undefined,
      postPrice: draft.dealabsPostPrice ?? undefined,
      checkedAt: draft.dealabsCheckedAt ?? undefined,
      statusAt: draft.dealabsStatusAt ?? undefined,
      source: draft.dealabsStatusSource ?? undefined,
      postedBy: draft.postedBy ?? undefined,
      history,
    };
  }

  /** Our posts by status (stats). */
  async counts(): Promise<Record<DealabsStatus, number>> {
    const counts: Record<DealabsStatus, number> = {
      not_published: 0,
      live: 0,
      expired: 0,
      hidden: 0,
      deleted: 0,
    };
    for (const draft of await this.drafts.findMany({})) {
      const status = currentDealabsStatus(draft);
      if (status === "not_published" && draft.status !== "posted") {
        // Only drafts that went out at some point are « our posts ».
        if (!draft.dealabsStatus) continue;
      }
      counts[status]++;
    }
    return counts;
  }
}
