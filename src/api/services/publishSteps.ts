/**
 * The phases of one Dealabs publication, in the order they happen.
 *
 * Shared by the server (which reports them) and the console (which draws
 * them): a step that didn't apply is shown as skipped rather than missing,
 * so the list always reads the same way. Pure data, no imports, so the
 * browser bundle can use it.
 */
export const PUBLISH_STEPS = [
  { id: "checks", label: "Vérifications préalables" },
  { id: "dealabs-duplicate", label: "Doublon déjà en ligne sur Dealabs" },
  { id: "merchant-check", label: "Page du marchand" },
  { id: "draft", label: "Brouillon" },
  { id: "chart", label: "Graphique de prix" },
  { id: "existing-post", label: "Recherche d'un post existant" },
  { id: "browser", label: "Ouverture du navigateur" },
  { id: "dealabs-open", label: "Ouverture de Dealabs" },
  { id: "cloudflare", label: "Vérification anti-robot" },
  { id: "login", label: "Connexion à Dealabs" },
  { id: "form-open", label: "Formulaire de publication" },
  { id: "form-link", label: "Lien du deal" },
  { id: "form-essentials", label: "Titre et prix" },
  { id: "form-description", label: "Description et image" },
  { id: "form-details", label: "Derniers détails" },
  { id: "submit", label: "Envoi" },
  { id: "session-save", label: "Session enregistrée" },
] as const;

export type PublishStepId = (typeof PUBLISH_STEPS)[number]["id"];

export type PublishStepStatus =
  | "pending"
  | "running"
  | "done"
  | "skipped"
  | "failed";

export interface PublishStep {
  id: PublishStepId;
  label: string;
  status: PublishStepStatus;
  startedAt?: string;
  finishedAt?: string;
  /** What happened, in French: « 189,99 € sur la page », « déjà connecté ». */
  detail?: string;
  /** Someone has to act in the « écran distant » (Cloudflare, login). */
  needsHuman?: boolean;
}

export type PublishTrigger = "button" | "schedule" | "collection";

/** One publication, as the console and the draft's trail show it. */
export interface PublishRun {
  runId: string;
  dealId: string;
  title: string;
  trigger: PublishTrigger;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Heartbeat: a "running" run silent for too long has died. */
  updatedAt: string;
  steps: PublishStep[];
  dealabsUrl?: string;
  error?: string;
}

export const publishStepLabel = (id: string): string =>
  PUBLISH_STEPS.find((step) => step.id === id)?.label ?? id;

/** The step a running publication is on, or the one that failed. */
export const currentPublishStep = (
  run: Pick<PublishRun, "steps">,
): PublishStep | undefined =>
  run.steps.find((step) => step.status === "running") ??
  run.steps.find((step) => step.status === "failed");
