import type { StoredDealabsDeal } from "./DealabsHistoryService.ts";
import { liveOnDealabs } from "./dealabsSearch.ts";
import { MIN_VISIBLE_SCORE } from "./ScoringService.ts";

/**
 * What a watched link's last check concluded, in words: the same checks
 * as any collected deal (quality gate, visibility bar, « pas d'argument
 * prix », live duplicate on Dealabs), said in French on the link. Pure.
 */
export interface LinkVerdict {
  status: "ok" | "refused" | "failed";
  verdict: string;
}

export interface LinkCheck {
  /** The shop's page was read and gave a price. */
  read: boolean;
  /** The quality gate's reason, when it rejected the offer. */
  rejected?: string;
  deal?: {
    score?: number | null;
    discountPercentage?: number | null;
    currentPrice: number;
    dealabsHistory?: string | null;
  };
  /** The scoring's warnings for this deal (`ScoringService.evaluate`). */
  warnings?: string[];
  /** Shop label, e.g. "Amazon.fr". */
  shop: string;
}

const euros = (value: number) =>
  `${value.toLocaleString("fr-FR", {
    minimumFractionDigits: value % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  })} €`;

const STILL_WATCHED =
  "Le lien reste surveillé : il est réévalué à chaque passage (une baisse de prix peut le rendre visible).";

export function linkVerdict(check: LinkCheck, now = new Date()): LinkVerdict {
  if (!check.read) {
    return {
      status: "failed",
      verdict: `Fiche produit illisible (page bloquée, produit retiré ou mise en page changée). Nouvel essai au prochain passage ${check.shop}.`,
    };
  }
  if (check.rejected) {
    return {
      status: "refused",
      verdict: `Écarté par le contrôle qualité : ${check.rejected}. ${STILL_WATCHED}`,
    };
  }
  const deal = check.deal;
  if (!deal) {
    return {
      status: "failed",
      verdict:
        "Offre lue mais pas enregistrée (erreur interne). Nouvel essai au prochain passage.",
    };
  }
  const score = deal.score ?? 0;
  if (score < MIN_VISIBLE_SCORE) {
    const noPriceArgument = check.warnings?.some((warning) =>
      warning.startsWith("Pas d'argument prix"),
    );
    return {
      status: "refused",
      verdict: noPriceArgument
        ? `Note ${score}/100, plafonnée : pas d'argument prix (ni vraie baisse, ni prix nettement sous la concurrence, ni plus bas historique). ${STILL_WATCHED}`
        : `Note ${score}/100, sous le seuil de visibilité (${MIN_VISIBLE_SCORE}). ${STILL_WATCHED}`,
    };
  }
  let history: StoredDealabsDeal[] = [];
  try {
    history = deal.dealabsHistory ? JSON.parse(deal.dealabsHistory) : [];
  } catch {
    // Unreadable history: no duplicate known.
  }
  const live = liveOnDealabs(history, deal.currentPrice, now);
  if (live) {
    return {
      status: "refused",
      verdict: `Déjà en ligne sur Dealabs à ${euros(live.price)} (${live.temperature}°)${live.mine ? ", posté par vous" : ""}, ici ${euros(deal.currentPrice)} : ${live.url}. Note ${score}/100, affiché grisé.`,
    };
  }
  const discount = deal.discountPercentage
    ? `, ${deal.discountPercentage} % sous le prix barré`
    : "";
  return {
    status: "ok",
    verdict: `Visible : note ${score}/100 à ${euros(deal.currentPrice)}${discount}.`,
  };
}
