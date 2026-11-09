import { $hook, $inject, Alepha } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { priceHistoryEntity } from "../entities/PriceHistory.ts";
import { watchedLinkEntity } from "../entities/WatchedLink.ts";
import type { DealabsThread } from "./dealabsSearch.ts";
import { MyDealabsPostsService } from "./MyDealabsPostsService.ts";
import { assessRealDrop } from "./priceDrop.ts";
import { type WatchedLink, WatchedLinkService } from "./WatchedLinkService.ts";
import {
  dealabsStanding,
  type WatchStatus,
  watchStatusOf,
  watchUpdate,
} from "./watchStatus.ts";

/** One status change, for the run log. */
export interface WatchStatusChange {
  linkId: string;
  dealId: string;
  title: string;
  from?: WatchStatus;
  to: WatchStatus;
  reason: string;
}

/**
 * « Mes ajouts » statuses (epic 33): recomputes a watched link's status
 * from what is stored — the deal as last read, its price history (real
 * drop, `assessRealDrop`) and where it stands on Dealabs (the same
 * `dealabsStanding` as the cards) — and writes it only when it changed.
 * Called after each read of the link (`CollectionService.recordLinkVerdict`)
 * and after each Dealabs re-check (`refreshDealabs`); never reads a shop or
 * Dealabs itself.
 */
export class WatchStatusService {
  protected alepha = $inject(Alepha);
  protected dateTime = $inject(DateTimeProvider);
  protected log = $logger();
  protected links = $repository(watchedLinkEntity);
  protected deals = $repository(dealEntity);
  protected drafts = $repository(dealabsDraftEntity);
  protected history = $repository(priceHistoryEntity);
  protected myPosts = $inject(MyDealabsPostsService);

  /** Links pasted before epic 33 get their first status, in the background. */
  onReady = $hook({
    on: "ready",
    handler: () => {
      if (this.alepha.isTest()) return;
      void this.backfill().catch((error: unknown) =>
        this.log.warn("Watch status backfill failed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  protected watchedLinks = $inject(WatchedLinkService);

  /** Watched links whose status counts (not removed, not stopped). */
  protected watched(): Promise<WatchedLink[]> {
    return this.watchedLinks.watchedForStatus();
  }

  async backfill(): Promise<number> {
    const missing = (await this.watched()).filter((link) => !link.watchStatus);
    const changes = await this.refresh(missing);
    return changes.length;
  }

  /**
   * Recomputes these links' statuses (all watched ones when omitted).
   * Returns the status changes.
   */
  async refresh(links?: WatchedLink[]): Promise<WatchStatusChange[]> {
    const list = (links ?? (await this.watched())).filter(
      (link) =>
        link.dealId && link.status !== "removed" && link.status !== "ended",
    );
    if (list.length === 0) return [];
    // The real list, waiting for it after a restart: `posts()` answers
    // an empty list while the profile is read again in the background,
    // which would take « Publié » away from what was posted by hand.
    const ourPosts = await this.myPosts
      .postsNow()
      .catch(() => [] as DealabsThread[]);
    const changes: WatchStatusChange[] = [];
    for (const link of list) {
      const change = await this.refreshOne(link, ourPosts).catch(
        (error: unknown) => {
          this.log.warn("Watch status not computed", {
            linkId: link.id,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        },
      );
      if (change) changes.push(change);
    }
    return changes;
  }

  protected async refreshOne(
    link: WatchedLink,
    ourPosts: DealabsThread[],
  ): Promise<WatchStatusChange | undefined> {
    const deal = await this.deals.findById(link.dealId as string);
    if (!deal) return undefined;
    const posted = await this.drafts.findOne({
      where: {
        and: [{ dealId: { eq: deal.id } }, { status: { eq: "posted" } }],
      },
    });
    const observations = (
      await this.history.findMany({ where: { dealId: { eq: deal.id } } })
    ).map((row) => ({
      price: row.price,
      observedAt: new Date(row.observedAt).toISOString(),
    }));
    const now = this.dateTime.nowISOString();
    let next = watchStatusOf({
      onDealabs: dealabsStanding(deal, posted ?? undefined, ourPosts),
      drop: assessRealDrop({
        price: deal.currentPrice,
        lowestRecentPrice: deal.lowestRecentPrice,
        listPrice: deal.listPrice,
        listPriceKind: deal.listPriceKind,
        // Each day's closing price before today (`dailyPrices`): today's
        // reads are the price being judged, not its history.
        observations,
        now: new Date(now),
      }),
    });
    // Re-read: a removal or another refresh may have happened meanwhile.
    const current = await this.links.getById(link.id);
    if (current.status === "removed" || current.status === "ended") {
      return undefined;
    }
    // Our profile unreadable (Dealabs down, nothing read yet): a product
    // « Publié » from it keeps that status rather than losing it on no
    // evidence. Our own drafts' status (epic 32) is read from the database.
    if (
      ourPosts.length === 0 &&
      !posted &&
      current.watchStatus === "published" &&
      next.status !== "published"
    ) {
      next = {
        status: "published",
        reason: current.watchReason ?? "Publié par vous sur Dealabs",
      };
    }
    const patch = watchUpdate(current, next, now);
    if (!patch) return undefined;
    await this.links.updateById(link.id, patch);
    if (current.watchStatus === next.status) return undefined;
    return {
      linkId: link.id,
      dealId: deal.id,
      title: deal.title,
      from: current.watchStatus ?? undefined,
      to: next.status,
      reason: next.reason,
    };
  }
}
