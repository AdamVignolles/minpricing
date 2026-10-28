import type { DealPageVerdict } from "./dealPageCheck.ts";

/**
 * What checking a deal before posting can conclude. `gone`, `out-of-stock`,
 * `price-changed` and `already-on-dealabs` are positive evidence;
 * `blocked` (no price readable) and `unreachable` (site down, timeout) mean
 * "unknown" and never remove a deal — they only hold the publish back.
 */
export const VERIFICATION_VERDICTS = [
  "ok",
  "gone",
  "out-of-stock",
  "price-changed",
  "already-on-dealabs",
  "blocked",
  "unreachable",
] as const;

export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

export interface VerificationResult {
  verdict: VerificationVerdict;
  /** French sentence shown in the console and on the refused publish. */
  reason?: string;
  /** For `price-changed`: what the merchant page shows instead. */
  observedPrice?: number;
  /** For `already-on-dealabs`: the live thread. */
  duplicate?: { url: string; price: number; temperature: number };
}

/** A result is still fresh (no new page opened) for this long. */
export const VERIFICATION_TTL_MS = 10 * 60 * 1000;

/** Maps a merchant page check to a verification result. */
export function verdictFromPageCheck(
  check: DealPageVerdict,
): VerificationResult {
  if (check.ok) return { verdict: "ok" };
  return {
    verdict: check.kind,
    reason: check.reason,
    observedPrice: check.observedPrice,
  };
}

/** Only a positive "it is gone" removes a deal from the lists. */
export function removesDeal(verdict: VerificationVerdict): boolean {
  return verdict === "gone" || verdict === "out-of-stock";
}

/** Anything but `ok` keeps the deal from being published. */
export function blocksPublish(verdict: VerificationVerdict): boolean {
  return verdict !== "ok";
}

/** Is a stored verification recent enough to be reused as is? */
export function isFresh(
  verifiedAt: string | undefined,
  now: Date,
  ttlMs = VERIFICATION_TTL_MS,
): boolean {
  if (!verifiedAt) return false;
  const age = now.getTime() - new Date(verifiedAt).getTime();
  return age >= 0 && age < ttlMs;
}
