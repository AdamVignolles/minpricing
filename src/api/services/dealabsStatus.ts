import {
  type DealabsThread,
  isSameProduct,
  liveOnDealabs,
} from "./dealabsSearch.ts";
/**
 * Each deal's true Dealabs status (epic 32): our post live, expired, hidden
 * by moderation or deleted — or never posted — checked back on our public
 * profile and the post's own page, instead of trusting the `posted` flag
 * set once at publication. Pure: matching profile posts to drafts, reading
 * a thread page's answer, the change history and the republish rules.
 * `DealabsStatusService` does the reading and the writing.
 */
import type { DealabsStatus } from "./dealabsStatusLabels.ts";

export {
  DEALABS_STATUS_LABELS,
  type DealabsStatus,
} from "./dealabsStatusLabels.ts";

/** Where a verdict came from. */
export type DealabsStatusSource =
  | "publish"
  | "profile"
  | "thread"
  | "moderation"
  | "manual-verify";

export type PostedBy = "agent" | "button" | "manual";

export interface DealabsStatusChange {
  at: string;
  from?: DealabsStatus;
  to: DealabsStatus;
  source: DealabsStatusSource;
  url?: string;
  temperature?: number;
}

/** History entries kept on the draft. */
export const STATUS_HISTORY_MAX = 20;

/** Dealabs' thread id: « …-3445887 », « /share-deal/3446484 ». */
export function dealabsThreadId(
  url: string | null | undefined,
): string | undefined {
  if (!url) return undefined;
  try {
    const path = new URL(url).pathname;
    return (
      path.match(/\/share-deal\/(\d+)/)?.[1] ??
      path.match(
        /\/(?:bons-plans|codes-promo|gratuit|discussions)\/[^/]*?-(\d{5,})\/?$/,
      )?.[1]
    );
  } catch {
    return undefined;
  }
}

/** A draft as the reconciler reads it. */
export interface DraftForStatus {
  id: string;
  dealId: string;
  status: string;
  dealabsUrl?: string | null;
  dealabsStatus?: string | null;
}

/** A deal as the reconciler reads it. */
export interface DealForStatus {
  id: string;
  title: string;
  currentPrice: number;
  sourceId: string;
  merchantId?: string | null;
}

const normalize = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

/**
 * Does the post's merchant name the deal's shop? Strict on purpose: a
 * post « chez Carrefour » is not our Amazon deal, whatever the title.
 * A post without a merchant name passes (the title decides).
 */
export function sameMerchant(
  post: { merchant?: string },
  deal: Pick<DealForStatus, "sourceId" | "merchantId">,
): boolean {
  if (!post.merchant) return true;
  const merchant = normalize(post.merchant);
  const keys = [deal.merchantId, deal.sourceId]
    .filter((key): key is string => !!key)
    .map((key) => normalize(key.split(/[-:]/)[0] ?? key))
    .filter((key) => key.length >= 3);
  return keys.some((key) => merchant.includes(key) || key.includes(merchant));
}

/**
 * Our own post's title for matching: `isSameProduct` reads 3+ commas as a
 * roundup of several products, but our titles list specs that way
 * (« Micro-Ondes Cecotec Proclean 5130 - 23L, Grill 1000W, … »).
 */
export const ownTitle = (title: string): string =>
  title.split(",").slice(0, 2).join(",");

export interface ProfileMatch {
  post: DealabsThread;
  draftId?: string;
  dealId?: string;
  /** How the post was found: its link, or the product (posted by hand). */
  by: "url" | "product";
}

/**
 * Our profile's posts matched to drafts: by thread id first (the link we
 * stored at publication), then by product — `isSameProduct` on the title
 * and price, plus the same shop — for posts published by hand or whose
 * link we never stored. A draft or a deal is used once; the newest post
 * wins when a product was posted twice.
 */
export function matchProfilePosts(
  posts: DealabsThread[],
  drafts: DraftForStatus[],
  deals: DealForStatus[],
): ProfileMatch[] {
  const matches: ProfileMatch[] = [];
  const usedDrafts = new Set<string>();
  const byThread = new Map<string, DraftForStatus>();
  for (const draft of drafts) {
    const id = dealabsThreadId(draft.dealabsUrl);
    if (id) byThread.set(id, draft);
  }
  const newestFirst = [...posts].sort((a, b) =>
    (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""),
  );
  const rest: DealabsThread[] = [];
  for (const post of newestFirst) {
    const draft =
      byThread.get(post.id) ?? byThread.get(dealabsThreadId(post.url) ?? "");
    if (draft && !usedDrafts.has(draft.id)) {
      usedDrafts.add(draft.id);
      matches.push({
        post,
        draftId: draft.id,
        dealId: draft.dealId,
        by: "url",
      });
    } else {
      rest.push(post);
    }
  }
  const draftOfDeal = new Map(drafts.map((draft) => [draft.dealId, draft]));
  const usedDeals = new Set(matches.map((match) => match.dealId));
  for (const post of rest) {
    const deal = deals.find(
      (candidate) =>
        !usedDeals.has(candidate.id) &&
        // A draft already tied to another thread is that thread's.
        !dealabsThreadId(draftOfDeal.get(candidate.id)?.dealabsUrl) &&
        sameMerchant(post, candidate) &&
        isSameProduct(candidate.title, candidate.currentPrice, {
          ...post,
          title: ownTitle(post.title),
        }),
    );
    if (!deal) continue;
    usedDeals.add(deal.id);
    const draft = draftOfDeal.get(deal.id);
    if (draft) usedDrafts.add(draft.id);
    matches.push({ post, draftId: draft?.id, dealId: deal.id, by: "product" });
  }
  return matches;
}

/** A profile post says live or expired. */
export const profileStatus = (post: Pick<DealabsThread, "isExpired">) =>
  post.isExpired ? ("expired" as const) : ("live" as const);

/**
 * A post's own page, read anonymously. 404/410 (or a redirect away from
 * the thread) = gone; a page saying it is awaiting moderation = hidden;
 * Cloudflare or any other answer = unknown, never a downgrade.
 */
export function threadPageStatus(page: {
  status: number;
  finalUrl?: string;
  html?: string;
  threadId?: string;
}): DealabsStatus | undefined {
  if (page.status === 404 || page.status === 410) return "deleted";
  if (page.status < 200 || page.status >= 300) return undefined;
  const html = page.html ?? "";
  if (
    /cf-challenge|challenge-platform|Just a moment|Vérification que vous n'êtes pas un robot/i.test(
      html,
    )
  ) {
    return undefined;
  }
  if (
    page.threadId &&
    page.finalUrl &&
    !page.finalUrl.includes(page.threadId)
  ) {
    return "deleted";
  }
  if (
    /deal (?:a été )?masqué|en attente de (?:validation|modération)|n'est pas encore visible|thread--moderated/i.test(
      html,
    )
  ) {
    return "hidden";
  }
  // The post's own JSON comes first on its page (related deals after):
  // its first `isExpired` is the post's (checked on live pages, 06/11).
  const expired = html.match(
    /(?:"|&quot;)isExpired(?:"|&quot;):\s*(true|false)/,
  );
  if (expired?.[1] === "true") return "expired";
  if (expired?.[1] === "false") return "live";
  if (
    html.includes(page.threadId ?? "") ||
    /threadTitle|thread-title/.test(html)
  ) {
    return "live";
  }
  return undefined;
}

/** The draft's history with one change added (newest last, capped). */
export function withChange(
  history: string | null | undefined,
  change: DealabsStatusChange,
): string {
  let list: DealabsStatusChange[] = [];
  try {
    list = history ? (JSON.parse(history) as DealabsStatusChange[]) : [];
  } catch {
    list = [];
  }
  return JSON.stringify([...list, change].slice(-STATUS_HISTORY_MAX));
}

export function readHistory(
  history: string | null | undefined,
): DealabsStatusChange[] {
  try {
    return history ? (JSON.parse(history) as DealabsStatusChange[]) : [];
  } catch {
    return [];
  }
}

/**
 * The status a draft stands at: the checked one, else what `posted`
 * implies (drafts posted before epic 32 count as live until checked).
 */
export function currentDealabsStatus(draft: {
  status: string;
  dealabsStatus?: string | null;
}): DealabsStatus {
  if (draft.dealabsStatus) return draft.dealabsStatus as DealabsStatus;
  return draft.status === "posted" ? "live" : "not_published";
}

/** Our post's price, from the change history's profile reading. */
export interface RepublishInput {
  status: DealabsStatus;
  currentPrice: number;
  /** The price of our expired post, when known. */
  postedPrice?: number;
  /** Someone else's live post for the product (stored history). */
  othersLive: boolean;
  /** « Prêt pour Dealabs » verdict now (epic 29). */
  readiness: "ok" | "fix" | "block";
  /** The moderation reason of a hidden/deleted post, if one was read. */
  moderationReason?: string | null;
}

/**
 * May the agents publish this deal again (owner's decisions, 2026-11-05)?
 * - `live`: never;
 * - `hidden` / `deleted`: once fixed — the « Prêt pour Dealabs » checks
 *   pass now (they block what the moderators objected to: seller, image,
 *   local offer, stock, language…);
 * - `expired`: when the price is good again — the normal selection rules
 *   apply as for any deal (the caller's), and today's price is not higher
 *   than our expired post's;
 * - never while someone else's post for it is live.
 */
export function republishVerdict(input: RepublishInput): {
  allowed: boolean;
  reason: string;
} {
  const euros = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;
  if (input.status === "not_published") {
    return { allowed: true, reason: "jamais publié" };
  }
  if (input.status === "live") {
    return { allowed: false, reason: "notre post est en ligne" };
  }
  if (input.othersLive) {
    return {
      allowed: false,
      reason: "un autre membre a un post en ligne pour ce produit",
    };
  }
  if (input.readiness === "block") {
    return {
      allowed: false,
      reason: "pas prêt pour Dealabs (la cause du refus n'est pas réglée)",
    };
  }
  if (input.status === "expired") {
    if (
      input.postedPrice !== undefined &&
      input.currentPrice > input.postedPrice + 0.009
    ) {
      return {
        allowed: false,
        reason: `prix ${euros(input.currentPrice)} au-dessus de notre post expiré (${euros(input.postedPrice)})`,
      };
    }
    return {
      allowed: true,
      reason: `republication : prix revenu à ${euros(input.currentPrice)}${input.postedPrice !== undefined ? ` (post expiré à ${euros(input.postedPrice)})` : ""}`,
    };
  }
  return {
    allowed: true,
    reason: `republication : post ${input.status === "hidden" ? "masqué" : "supprimé"}${input.moderationReason ? ` (${input.moderationReason})` : ""}, cause réglée`,
  };
}

/** Someone else's live post, from the stored Dealabs history. */
export function othersLiveOnDealabs(
  history: string | null | undefined,
  price: number,
  now?: Date,
): boolean {
  let list: Array<{
    url: string;
    price: number;
    temperature: number;
    publishedAt: string;
    isExpired?: boolean;
    mine?: boolean;
  }> = [];
  try {
    list = history ? JSON.parse(history) : [];
  } catch {
    list = [];
  }
  return !!liveOnDealabs(
    list.filter((entry) => !entry.mine),
    price,
    now,
  );
}

/** « Dealabs : 24 en ligne, 3 expirés… » for the run log. */
export function statusSummaryLine(counts: {
  live: number;
  expired: number;
  hidden: number;
  deleted: number;
  attached: number;
  changes: number;
  unreadable?: number;
}): string {
  return `Dealabs : ${counts.live} en ligne, ${counts.expired} expiré(s), ${counts.hidden} masqué(s), ${counts.deleted} supprimé(s), ${counts.attached} publié(s) à la main rattaché(s), ${counts.changes} changement(s)${counts.unreadable ? `, ${counts.unreadable} illisible(s) (inchangés)` : ""}`;
}
