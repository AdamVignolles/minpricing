import type { StoredDealabsDeal } from "./DealabsHistoryService.ts";
import {
  type DealabsThread,
  isSameProduct,
  liveOnDealabs,
  type OnDealabs,
} from "./dealabsSearch.ts";
import { currentDealabsStatus, ownTitle } from "./dealabsStatus.ts";
import {
  describeDrop,
  describeNoDrop,
  type RealDropVerdict,
} from "./priceDrop.ts";

/**
 * Where a deal stands on Dealabs, for its card: our post (published
 * draft, its checked status — epic 32), one of our live posts read from
 * our profile, or someone else's live deal from the stored history. One
 * function for the lists' greyed cards and the watch statuses of
 * « Mes ajouts » (epic 33), so the two can't disagree. Pure.
 */
export function dealabsStanding(
  deal: {
    title: string;
    currentPrice: number;
    dealabsHistory?: string | null;
  },
  postedDraft:
    | {
        dealabsUrl?: string | null;
        dealabsPostPrice?: number | null;
        dealabsTemperature?: number | null;
        dealabsStatus?: string | null;
        status: string;
      }
    | undefined,
  ourLivePosts: DealabsThread[],
): OnDealabs | undefined {
  if (postedDraft) {
    const status = currentDealabsStatus(postedDraft);
    if (status !== "not_published") {
      return {
        url: postedDraft.dealabsUrl ?? "",
        price: postedDraft.dealabsPostPrice ?? deal.currentPrice,
        temperature: postedDraft.dealabsTemperature ?? 0,
        mine: true,
        status: status as OnDealabs["status"],
      };
    }
  }
  const ours = ourLivePosts.find(
    (post) =>
      !post.isExpired &&
      isSameProduct(deal.title, deal.currentPrice, {
        ...post,
        title: ownTitle(post.title),
      }),
  );
  if (ours) {
    return {
      url: ours.url,
      price: ours.price,
      temperature: Math.round(ours.temperature),
      mine: true,
      status: "live",
    };
  }
  let history: StoredDealabsDeal[] = [];
  try {
    history = deal.dealabsHistory ? JSON.parse(deal.dealabsHistory) : [];
  } catch {
    // Unreadable history: no status.
  }
  return liveOnDealabs(history, deal.currentPrice);
}

/** A hand-added product's status (epic 33). */
export type WatchStatus = "waiting" | "price_drop" | "published" | "on_dealabs";

export const WATCH_STATUS_LABELS: Record<WatchStatus, string> = {
  waiting: "Pas intéressant",
  price_drop: "Baisse de prix",
  published: "Publié",
  on_dealabs: "Déjà sur Dealabs",
};

const euros = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;

/**
 * The status, in this order: our post live on Dealabs (« Publié »),
 * someone else's live post (« Déjà sur Dealabs »), a real drop
 * (« Baisse de prix », `assessRealDrop`), else « Pas intéressant ». Our
 * post expired, hidden or deleted counts as not on Dealabs: the product
 * is back in the running. Pure.
 */
export function watchStatusOf(input: {
  onDealabs?: OnDealabs;
  drop: RealDropVerdict;
}): { status: WatchStatus; reason: string } {
  const { onDealabs, drop } = input;
  if (onDealabs?.mine && (onDealabs.status ?? "live") === "live") {
    return {
      status: "published",
      reason: `Publié par vous sur Dealabs${onDealabs.temperature ? ` (${onDealabs.temperature}°)` : ""}`,
    };
  }
  if (onDealabs && !onDealabs.mine) {
    return {
      status: "on_dealabs",
      reason: `Déjà en ligne sur Dealabs à ${euros(onDealabs.price)}${onDealabs.temperature ? ` (${onDealabs.temperature}°)` : ""}`,
    };
  }
  if ("drop" in drop) {
    return { status: "price_drop", reason: describeDrop(drop.drop) };
  }
  const expired =
    onDealabs?.mine && onDealabs.status && onDealabs.status !== "live"
      ? "Votre deal Dealabs n'est plus en ligne ; "
      : "";
  return {
    status: "waiting",
    reason: `${expired}${describeNoDrop(drop)}`.replace(/^./, (c) =>
      c.toUpperCase(),
    ),
  };
}

export interface WatchChange {
  at: string;
  from?: WatchStatus;
  to: WatchStatus;
  reason: string;
}

const HISTORY_MAX = 20;

/**
 * The columns to write on the link, or undefined when nothing changed —
 * a status kept as it was is not rewritten. A new status goes to the
 * history (newest last, 20 kept).
 */
export function watchUpdate(
  link: {
    watchStatus?: WatchStatus | null;
    watchReason?: string | null;
    watchHistory?: string | null;
  },
  next: { status: WatchStatus; reason: string },
  at: string,
):
  | {
      watchStatus: WatchStatus;
      watchReason: string;
      watchStatusAt?: string;
      watchHistory?: string;
    }
  | undefined {
  const changed = link.watchStatus !== next.status;
  if (!changed && link.watchReason === next.reason) return undefined;
  if (!changed) return { watchStatus: next.status, watchReason: next.reason };
  let history: WatchChange[] = [];
  try {
    history = link.watchHistory ? JSON.parse(link.watchHistory) : [];
  } catch {
    history = [];
  }
  history.push({
    at,
    ...(link.watchStatus ? { from: link.watchStatus } : {}),
    to: next.status,
    reason: next.reason,
  });
  return {
    watchStatus: next.status,
    watchReason: next.reason,
    watchStatusAt: at,
    watchHistory: JSON.stringify(history.slice(-HISTORY_MAX)),
  };
}
