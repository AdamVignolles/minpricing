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
import type { WatchStatus } from "./watchStatus.ts";

export type WatchedLink = Infer<typeof watchedLinkEntity.schema>;

/**
 * How long a pasted link is read on every run of its shop (hourly). After
 * that it is read once a day (epic 33), hourly again while its status is
 * « Baisse de prix »; the watch only ends by « Retirer » or « Arrêter ».
 */
export const WATCH_DAYS = 14;
/** Past the hourly phase, a link is read again after this long. */
export const DAILY_READ_MS = 23 * 3_600_000;

/**
 * Is this link due for a read now? Hourly while new (before
 * `watchUntil`), never read, waiting for its first verdict or in
 * « Baisse de prix »; otherwise once a day. Pure.
 */
export function linkDue(
  link: Pick<
    WatchedLink,
    "status" | "watchUntil" | "lastCheckedAt" | "watchStatus"
  >,
  now: Date,
): boolean {
  if (link.status === "ended" || link.status === "removed") return false;
  if (!link.lastCheckedAt || link.status === "pending") return true;
  if (link.watchStatus === "price_drop") return true;
  if (new Date(link.watchUntil).getTime() > now.getTime()) return true;
  return (
    now.getTime() - new Date(link.lastCheckedAt).getTime() >= DAILY_READ_MS
  );
}

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
   * The links a run of this source reads now (every shop's without one):
   * neither ended nor removed, and due (`linkDue`: hourly for the first
   * {@link WATCH_DAYS} days or while « Baisse de prix », then daily). The
   * watch never ends on its own (epic 33).
   */
  async active(sourceId?: string): Promise<WatchedLink[]> {
    const now = new Date(this.dateTime.nowISOString());
    const watched = {
      status: { notInArray: ["ended" as const, "removed" as const] },
    };
    const links = await this.links.findMany({
      where: sourceId
        ? { and: [{ sourceId: { eq: sourceId } }, watched] }
        : watched,
    });
    return links.filter((link) => linkDue(link, now));
  }

  /**
   * Every link whose « Mes ajouts » status counts (epic 33): pointing at a
   * deal, neither ended nor removed — due for a read or not.
   */
  async watchedForStatus(): Promise<WatchedLink[]> {
    return this.links.findMany({
      where: {
        and: [
          { dealId: { isNotNull: true } },
          { status: { notInArray: ["ended", "removed"] } },
        ],
      },
    });
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

  /** Stops watching (« Arrêter »). */
  async end(id: string, verdict?: string): Promise<WatchedLink> {
    const link = await this.links.getById(id);
    if (link.status === "removed") return link;
    return this.links.updateById(id, {
      status: "ended",
      ...(verdict ? { verdict } : {}),
    });
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
   * Each hand-added deal's « Mes ajouts » status (epic 33): its link's,
   * « Pas intéressant » until a first one is computed. Removed links are
   * left out, like `handPickedDealIds`.
   */
  async statusesByDeal(): Promise<Map<string, WatchStatus>> {
    const links = await this.links.findMany({
      where: {
        and: [{ dealId: { isNotNull: true } }, { status: { ne: "removed" } }],
      },
    });
    return new Map(
      links.map((link) => [
        link.dealId as string,
        (link.watchStatus ?? "waiting") as WatchStatus,
      ]),
    );
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
