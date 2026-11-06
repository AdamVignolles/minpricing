/**
 * Dealabs status names in French (epic 32). Pure data, no imports, so the
 * browser bundle can use it (`dealabsStatus.ts` reaches server code).
 */
export type DealabsStatus =
  | "not_published"
  | "live"
  | "expired"
  | "hidden"
  | "deleted";

export const DEALABS_STATUS_LABELS: Record<DealabsStatus, string> = {
  not_published: "Pas publié",
  live: "En ligne",
  expired: "Expiré",
  hidden: "Masqué par la modération",
  deleted: "Supprimé",
};
