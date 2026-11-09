/**
 * Dealabs moderation, after publication (epic 29). Moderators hide a post
 * they find incomplete and write to the poster (« L'équipe Dealabs »);
 * nobody answering within 3–4 hours gets it deleted. DealRadar only reads
 * these messages, files them on the draft and alerts Adam — it never
 * replies and never edits a post (owner's decision, 2026-11-04).
 *
 * Pure: parsing a message, matching it to one of our drafts, reading a
 * thread's public status, and what a rejection teaches the checklist.
 */
import {
  type BlockedSeller,
  type ModerationConfig,
  normalizeName,
} from "./dealabsReadiness.ts";

export type ModerationReason =
  | "incomplete:location-stock"
  | "incomplete:image"
  | "incomplete:price"
  | "seller"
  | "availability"
  | "deleted"
  | "other";

export type ModerationStatus = "hidden" | "deleted" | "ok";

export const MODERATION_REASON_LABELS: Record<ModerationReason, string> = {
  "incomplete:location-stock": "magasin, ville et stock restant demandés",
  "incomplete:image": "image du produit manquante",
  "incomplete:price": "prix introuvable par les modérateurs",
  seller: "vendeur sous les critères de fiabilité de Dealabs",
  availability: "produit plus disponible ou trop peu de stock",
  deleted: "deal supprimé",
  other: "autre demande des modérateurs",
};

export interface ModerationMessage {
  /** Stable id: the conversation's link, else a hash of the text. */
  id: string;
  from?: string;
  text: string;
  /** ISO date, when the page gives one. */
  at?: string;
  /** Dealabs thread links found in the message. */
  threadUrls: string[];
}

export interface ParsedModeration {
  status: ModerationStatus;
  reason: ModerationReason;
  /** The sentences that say what is asked, quoted. */
  requested: string[];
  /** Hours given to fix it, when the message says. */
  deadlineHours?: number;
}

/** Is this from Dealabs' team (not a member's private message)? */
export const isFromModerators = (message: {
  from?: string;
  text: string;
}): boolean =>
  /(?:équipe|equipe) dealabs|modérat|moderat|dealabs team/i.test(
    `${message.from ?? ""} ${message.text.slice(0, 400)}`,
  ) ||
  /votre (?:deal|bon plan) (?:a été|est) (?:masqué|supprimé|désactivé|mis en attente)/i.test(
    message.text,
  );

const REASONS: Array<[ModerationReason, RegExp]> = [
  [
    "incomplete:location-stock",
    /\b(?:magasin|ville|localisation|stock restant|quantit[ée] (?:restante|disponible)|nombre d'articles?)\b/i,
  ],
  ["incomplete:image", /\b(?:image|photo|visuel)\b/i],
  [
    "seller",
    /vendeur[^.]{0,80}(?:fiab|critère|marketplace|tiers|non recommand)|(?:fiabilité|critères)[^.]{0,60}vendeur/i,
  ],
  [
    "incomplete:price",
    /prix[^.]{0,60}(?:introuvable|retrouv|ne correspond|pas le même|différent|n'apparaît|trouvons pas)|(?:pas|impossible de) (?:retrouver|trouver) (?:le|ce) prix|(?:trouvons|trouve|retrouvons|retrouve) pas (?:le|ce) prix/i,
  ],
  [
    "availability",
    /plus disponible|n'est plus en stock|rupture|épuisé|trop peu (?:de|d')\s*(?:stock|exemplaires|quantité)|stock (?:insuffisant|limité)|expiré/i,
  ],
];

const REQUEST =
  /(?:merci (?:de|d')|veuillez|il manque|pourriez-vous|pouvez-vous|nous avons besoin|il faut|indiquez|précisez|ajoutez)[^.!?\n]{3,240}[.!?]?/gi;

/** What a moderator's message says, sorted into a category. */
export function parseModerationMessage(text: string): ParsedModeration {
  const clean = text.replace(/\s+/g, " ").trim();
  // « sans quoi il sera supprimé » is a warning, not a deletion.
  const deleted =
    /(?:a été|est) supprimé|nous avons supprimé|suppression de votre deal a été/i.test(
      clean,
    ) && !/(?:a été|est) masqué/i.test(clean);
  const reason =
    REASONS.find(([, pattern]) => pattern.test(clean))?.[0] ??
    (deleted ? "deleted" : "other");
  const requested = [...clean.matchAll(REQUEST)]
    .map((match) => match[0].trim())
    .filter((line, index, all) => all.indexOf(line) === index)
    .slice(0, 4);
  const hours = clean.match(
    /(?:sous|dans les?|d'ici|délai de)\s+(\d{1,2})\s*(?:h\b|heures?)/i,
  );
  return {
    status: deleted ? "deleted" : "hidden",
    reason,
    requested,
    deadlineHours: hours ? Number(hours[1]) : undefined,
  };
}

const THREAD_URL =
  /https?:\/\/www\.dealabs\.com\/(?:bons-plans|codes-promo|gratuit)\/[a-z0-9-]+-(\d+)/gi;

/** Thread links in a text, normalised (no query, no anchor). */
export function threadUrls(text: string): string[] {
  return [...new Set([...text.matchAll(THREAD_URL)].map((match) => match[0]))];
}

/** « …-3120456 » → "3120456". */
export const threadId = (url: string): string | undefined =>
  url.match(/-(\d+)(?:[/?#]|$)/)?.[1];

export interface DraftForMatch {
  dealId: string;
  title: string;
  dealabsUrl?: string | null;
}

const words = (text: string) =>
  new Set(
    normalizeName(text)
      .split(" ")
      .filter((word) => word.length >= 3),
  );

/**
 * Which of our posted drafts a message is about: by thread link first,
 * else by title (≥ 60 % of the draft title's words quoted in it).
 */
export function matchMessageToDraft<T extends DraftForMatch>(
  message: Pick<ModerationMessage, "text" | "threadUrls">,
  drafts: T[],
): T | undefined {
  const ids = new Set(
    [...message.threadUrls, ...threadUrls(message.text)]
      .map(threadId)
      .filter(Boolean),
  );
  const byUrl = drafts.find(
    (draft) => draft.dealabsUrl && ids.has(threadId(draft.dealabsUrl)),
  );
  if (byUrl) return byUrl;
  const text = words(message.text);
  let best: { draft: T; share: number } | undefined;
  for (const draft of drafts) {
    const title = words(draft.title);
    if (title.size < 3) continue;
    const share =
      [...title].filter((word) => text.has(word)).length / title.size;
    if (share >= 0.6 && (!best || share > best.share)) best = { draft, share };
  }
  return best?.draft;
}

/**
 * A thread's public page, read anonymously: gone (404/410) means hidden
 * or deleted — the message, when there is one, says which.
 */
export function threadPublicStatus(
  httpStatus: number,
): ModerationStatus | undefined {
  if (httpStatus === 410) return "deleted";
  if (httpStatus === 404) return "hidden";
  if (httpStatus >= 200 && httpStatus < 300) return "ok";
  return undefined;
}

/** What a rejection changes in `config/moderation.json` (epic 29, #141). */
export interface ModerationLesson {
  config: ModerationConfig & Record<string, unknown>;
  changes: string[];
}

/**
 * The checklist learns from each rejection: a « vendeur non fiable » adds
 * the seller to the blocklist, « magasin et stock » marks the source
 * local, « plus disponible » raises the stock threshold by one (within
 * its bounds). Returns undefined when nothing changes.
 */
export function learnFromRejection(
  config: ModerationConfig & {
    bounds?: Record<string, [number, number]>;
  } & Record<string, unknown>,
  rejection: {
    reason: ModerationReason;
    sourceId: string;
    sellerName?: string | null;
    title: string;
    at: string;
  },
): ModerationLesson | undefined {
  const next = {
    ...config,
    sellerBlocklist: [...config.sellerBlocklist],
    localSources: [...config.localSources],
  };
  const changes: string[] = [];
  const day = rejection.at.slice(0, 10);
  if (rejection.reason === "seller" && rejection.sellerName?.trim()) {
    const name = rejection.sellerName.trim();
    const known = next.sellerBlocklist.some(
      (entry: BlockedSeller) =>
        normalizeName(entry.name) === normalizeName(name),
    );
    if (!known) {
      next.sellerBlocklist.push({
        name,
        reason: `refusé par Dealabs : ${rejection.title.slice(0, 80)} (${day})`,
        at: day,
        by: "moderation-inbox",
      });
      changes.push(`vendeur bloqué : ${name}`);
    }
  }
  if (
    rejection.reason === "incomplete:location-stock" &&
    !next.localSources.includes(rejection.sourceId)
  ) {
    next.localSources.push(rejection.sourceId);
    changes.push(`source locale : ${rejection.sourceId}`);
  }
  if (rejection.reason === "availability") {
    const max = config.bounds?.minStock?.[1] ?? 20;
    if (next.minStock < max) {
      next.minStock = next.minStock + 1;
      changes.push(`stock minimum : ${config.minStock} → ${next.minStock}`);
    }
  }
  if (changes.length === 0) return undefined;
  return {
    config: { ...next, updatedAt: day, updatedBy: "moderation-inbox" },
    changes,
  };
}
