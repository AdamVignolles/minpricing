import { $inject, type Infer } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $repository } from "alepha/orm";

import type { ProductRef } from "../collectors/DealSource.ts";
import { watchedLinkEntity } from "../entities/WatchedLink.ts";
import {
  type LinkResolution,
  resolveLink,
  SUPPORTED_SHOPS,
} from "./linkResolver.ts";
import { type LinkStep, initialLinkSteps } from "./linkSteps.ts";
import type { LinkVerdict } from "./linkVerdict.ts";

export type WatchedLink = Infer<typeof watchedLinkEntity.schema>;

/** How long a pasted link is re-read on each run of its shop. */
export const WATCH_DAYS = 14;

export type AddLinkResult =
  | { ok: true; link: WatchedLink; duplicate: boolean }
  | Extract<LinkResolution, { ok: false }>;

/**
 * Watched links (see `WatchedLink`): adding one, handing the active ones
 * to their shop's collector, recording what each check concluded, and
 * ending the watch. The check itself is `CollectionService.checkLink`.
 */
export class WatchedLinkService {
  protected dateTime = $inject(DateTimeProvider);
  protected links = $repository(watchedLinkEntity);

  /** Overridable in tests: the network behind short links. */
  protected fetcher: typeof fetch = (...args) => fetch(...args);

  /**
   * Resolves the link (instant refusal for unsupported shops) and starts
   * watching it. The same product already watched is not added twice:
   * that watch is renewed and returned (`duplicate`).
   */
  async add(url: string, addedBy: string): Promise<AddLinkResult> {
    const resolution = await resolveLink(url, this.fetcher);
    if (!resolution.ok) return resolution;
    const watchUntil = new Date(
      new Date(this.dateTime.nowISOString()).getTime() +
        WATCH_DAYS * 86_400_000,
    ).toISOString();
    const existing = await this.links.findOne({
      where: {
        and: [
          { sourceId: { eq: resolution.sourceId } },
          { externalId: { eq: resolution.externalId } },
        ],
      },
    });
    if (existing) {
      // Ended or removed by hand: pasting it again watches it again.
      const revived =
        existing.status === "ended" || existing.status === "removed";
      const link = await this.links.updateById(existing.id, {
        watchUntil,
        status: revived ? "pending" : existing.status,
        steps: JSON.stringify(initialLinkSteps()),
      });
      return { ok: true, link, duplicate: !revived };
    }
    const link = await this.links.create({
      url: url.trim().slice(0, 1000),
      canonicalUrl: resolution.canonicalUrl,
      sourceId: resolution.sourceId,
      externalId: resolution.externalId,
      addedBy: addedBy.slice(0, 80),
      status: "pending",
      steps: JSON.stringify(initialLinkSteps()),
      watchUntil,
    });
    return { ok: true, link, duplicate: false };
  }

  get(id: string): Promise<WatchedLink> {
    return this.links.getById(id);
  }

  /** Newest first. */
  async recent(limit = 50): Promise<WatchedLink[]> {
    return (await this.links.findMany({}))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  /**
   * The links a run of this source reads (every shop's without one): not
   * ended nor removed, watch not over. Ends the ones whose time is up on
   * the way.
   */
  async active(sourceId?: string): Promise<WatchedLink[]> {
    const now = this.dateTime.nowISOString();
    const watched = {
      status: { notInArray: ["ended" as const, "removed" as const] },
    };
    const links = await this.links.findMany({
      where: sourceId
        ? { and: [{ sourceId: { eq: sourceId } }, watched] }
        : watched,
    });
    const over = links.filter(
      (link) => new Date(link.watchUntil).getTime() <= new Date(now).getTime(),
    );
    for (const link of over) {
      await this.end(
        link.id,
        `Surveillance terminée après ${WATCH_DAYS} jours. ${link.verdict ?? ""}`.trim(),
      );
    }
    return links.filter((link) => !over.includes(link));
  }

  /** What a collector's `collect()` needs to read the link's product. */
  toRef(link: WatchedLink): ProductRef {
    return {
      id: link.id,
      url: link.canonicalUrl,
      externalId: link.externalId,
    };
  }

  async record(
    id: string,
    verdict: LinkVerdict,
    dealId?: string,
  ): Promise<WatchedLink> {
    // A check still running when the link was removed must not revive it.
    const removed = (await this.links.getById(id)).status === "removed";
    return this.links.updateById(id, {
      ...(removed ? {} : { status: verdict.status }),
      verdict: verdict.verdict,
      lastCheckedAt: this.dateTime.nowISOString(),
      ...(dealId ? { dealId } : {}),
    });
  }

  async setSteps(id: string, steps: LinkStep[]): Promise<void> {
    await this.links.updateById(id, { steps: JSON.stringify(steps) });
  }

  /** Stops watching (button, watch over, deal expired). */
  async end(id: string, verdict?: string): Promise<WatchedLink> {
    const link = await this.links.getById(id);
    if (link.status === "removed") return link;
    return this.links.updateById(id, {
      status: "ended",
      ...(verdict ? { verdict } : {}),
    });
  }

  /**
   * Ends the watch of links whose deal expired: unread for 48 h like any
   * collected deal (see `CollectionService.expireUnseen`).
   */
  async endForExpiredDeals(expiredDealIds: string[]): Promise<number> {
    if (expiredDealIds.length === 0) return 0;
    const links = await this.links.findMany({
      where: {
        and: [
          { dealId: { inArray: expiredDealIds } },
          { status: { notInArray: ["ended", "removed"] } },
        ],
      },
    });
    for (const link of links) {
      await this.end(
        link.id,
        "Surveillance arrêtée : l'offre n'a plus été lue depuis 48 h (expirée).",
      );
    }
    return links.length;
  }

  /**
   * Links per deal, for the « ajouté par lien » flag. Removed links are
   * left out: their deal is no longer « ajouté à la main ».
   */
  async byDeal(dealIds: string[]): Promise<Map<string, WatchedLink>> {
    if (dealIds.length === 0) return new Map();
    const links = await this.links.findMany({
      where: {
        and: [{ dealId: { inArray: dealIds } }, { status: { ne: "removed" } }],
      },
    });
    return new Map(links.map((link) => [link.dealId as string, link]));
  }

  /**
   * Every deal a pasted link pointed at (watch ended or not, but not
   * removed by hand): the deals « ajoutés à la main ».
   */
  async handPickedDealIds(): Promise<string[]> {
    const links = await this.links.findMany({
      where: {
        and: [{ dealId: { isNotNull: true } }, { status: { ne: "removed" } }],
      },
    });
    return [...new Set(links.map((link) => link.dealId as string))];
  }

  /**
   * Takes a deal out of the deals « ajoutés à la main »: its links stop
   * being watched and lose their exemptions (quality gate, visibility
   * bar, evening selection). The deal itself stays; the next run applies
   * the normal rules to it. Pasting the link again brings it back.
   * Returns how many links were removed (0: not a hand-added deal).
   */
  async removeByDeal(dealId: string): Promise<number> {
    const links = await this.links.findMany({
      where: {
        and: [{ dealId: { eq: dealId } }, { status: { ne: "removed" } }],
      },
    });
    for (const link of links) {
      await this.links.updateById(link.id, {
        status: "removed",
        verdict: "Retiré des ajouts à la main.",
      });
    }
    return links.length;
  }

  /** Labels and examples, for the console's hint and refusals. */
  supportedShops() {
    return SUPPORTED_SHOPS.map(({ sourceId, label, example }) => ({
      sourceId,
      label,
      example,
    }));
  }
}
