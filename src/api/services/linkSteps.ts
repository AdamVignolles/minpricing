/**
 * The steps of one link check, stored on the watched link (`steps`, JSON)
 * and drawn live by the console while the check runs.
 */
export type LinkStepId =
  | "resolve"
  | "page"
  | "market"
  | "dealabs"
  | "score"
  | "verdict";

export interface LinkStep {
  id: LinkStepId;
  label: string;
  status: "pending" | "running" | "done" | "skipped" | "failed";
  detail?: string;
}

export const LINK_STEPS: Array<Pick<LinkStep, "id" | "label">> = [
  { id: "resolve", label: "Lien reconnu" },
  { id: "page", label: "Lecture de la fiche produit" },
  { id: "market", label: "Comparaison avec d'autres boutiques" },
  { id: "dealabs", label: "Historique Dealabs" },
  { id: "score", label: "Note et contrôle qualité" },
  { id: "verdict", label: "Verdict" },
];

export const initialLinkSteps = (): LinkStep[] =>
  LINK_STEPS.map((step) => ({
    ...step,
    status: step.id === "resolve" ? "done" : "pending",
  }));

export function parseLinkSteps(raw?: string | null): LinkStep[] {
  if (!raw) return [];
  try {
    const steps = JSON.parse(raw);
    return Array.isArray(steps) ? steps : [];
  } catch {
    return [];
  }
}
