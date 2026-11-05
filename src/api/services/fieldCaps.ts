import { dealEntity } from "../entities/Deal.ts";

/**
 * Epic 28: an offer is never lost to a length limit. Identifiers and URLs
 * have room (2 000 characters, titles 1 000 — see the entities), and
 * anything still over its column's cap is cut here, before the row is
 * validated, instead of the whole offer being skipped (« Offre ignorée …
 * Too big »). Pure: the caller logs what was cut.
 */

/** A text field's `maxLength`, read from the entity schema itself. */
function maxLengthOf(field: unknown): number | undefined {
  let current = field as
    | {
        maxLength?: number | null;
        unwrap?: () => unknown;
        def?: { innerType?: unknown };
      }
    | undefined;
  for (let depth = 0; current && depth < 4; depth++) {
    if (typeof current.maxLength === "number") return current.maxLength;
    const inner =
      current.def?.innerType ??
      (typeof current.unwrap === "function" ? current.unwrap() : undefined);
    if (!inner || inner === current) return undefined;
    current = inner as typeof current;
  }
  return undefined;
}

/** Text caps of a schema's fields (fields without a cap are left out). */
export function textCaps(schema: unknown): Record<string, number> {
  const shape =
    (schema as { shape?: Record<string, unknown> }).shape ??
    (schema as { properties?: Record<string, unknown> }).properties ??
    {};
  const caps: Record<string, number> = {};
  for (const [name, field] of Object.entries(shape)) {
    const max = maxLengthOf(field);
    if (max !== undefined) caps[name] = max;
  }
  return caps;
}

/** Caps of the `deals` columns. */
export const DEAL_FIELD_CAPS: Record<string, number> = textCaps(
  dealEntity.schema,
);

/** Cuts text at a word boundary, with « … », to `max` characters. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  // URLs and ids have no words: a plain cut.
  if (!/\s/.test(text.slice(0, max))) return text.slice(0, max);
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:–—-]+$/, "")}…`;
}

export interface FieldCut {
  field: string;
  length: number;
  max: number;
}

/**
 * Returns `values` with every string over its cap cut, and which fields
 * were. Non-string values and fields without a cap are kept as they are.
 */
export function fitFields<T extends Record<string, unknown>>(
  values: T,
  caps: Record<string, number> = DEAL_FIELD_CAPS,
): { values: T; cuts: FieldCut[] } {
  const cuts: FieldCut[] = [];
  const out: Record<string, unknown> = { ...values };
  for (const [field, value] of Object.entries(values)) {
    const max = caps[field];
    if (typeof value !== "string" || max === undefined) continue;
    if (value.length <= max) continue;
    out[field] = cutText(value, max);
    cuts.push({ field, length: value.length, max });
  }
  return { values: out as T, cuts };
}

/** « champ url raccourci (2 340 → 2 000 caractères) », for the run log. */
export function describeCuts(cuts: FieldCut[]): string {
  return cuts
    .map((cut) => `champ ${cut.field} raccourci (${cut.length} → ${cut.max})`)
    .join(", ");
}
