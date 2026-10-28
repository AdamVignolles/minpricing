import { SOURCE_EVERY_HOURS_BOUNDS } from "./collectionTuning.ts";

/**
 * What the agents may change in the files they tune (`config/*`), checked
 * by the server before anything is written (`AgentApiController`). The
 * bounds travel inside each file, and the parts that set them — `bounds`,
 * Adam's preferences, the locked sources, the verified page URLs — must
 * come back unchanged: an agent moves values inside the fence, never the
 * fence. Each validator returns the list of problems (empty = accepted)
 * and a short list of what changed, for the audit trail.
 */
export const AGENT_CONFIGS = {
  "publish-rules": { file: "publish-rules.json", changelog: "publish-rules" },
  desirability: { file: "desirability.json", changelog: "desirability" },
  collection: { file: "collection.json", changelog: "sources" },
  "selection-lessons": { file: "selection-lessons.md", changelog: undefined },
} as const;

export type AgentConfigName = keyof typeof AGENT_CONFIGS;

export const isAgentConfigName = (name: string): name is AgentConfigName =>
  Object.hasOwn(AGENT_CONFIGS, name);

/** Lessons are free text read by the selector: capped, not parsed. */
export const LESSONS_MAX_BYTES = 20_000;
/** Desirability keys an agent may move in one write (the skill says ~5). */
export const DESIRABILITY_MAX_KEYS_PER_WRITE = 6;

export interface ConfigCheck {
  errors: string[];
  changes: string[];
}

type Json = Record<string, any>;

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const isNum = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
const inRange = (v: unknown, [min, max]: number[]) =>
  isNum(v) && v >= min && v <= max;
const isObj = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function diffValues(
  label: string,
  before: unknown,
  after: unknown,
  changes: string[],
) {
  if (!same(before, after)) {
    changes.push(
      `${label}: ${JSON.stringify(before) ?? "∅"} → ${JSON.stringify(after) ?? "∅"}`,
    );
  }
}

function diffMap(label: string, before: Json, after: Json, changes: string[]) {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    diffValues(`${label}.${key}`, before[key], after[key], changes);
  }
}

function locked(
  keys: string[],
  previous: Json,
  next: Json,
  errors: string[],
): void {
  for (const key of keys) {
    if (!same(previous[key], next[key])) {
      errors.push(`« ${key} » est verrouillé (seul Adam le modifie)`);
    }
  }
}

/** `config/publish-rules.json` (deals-weekly, deals-debrief). */
export function checkPublishRules(previous: Json, next: Json): ConfigCheck {
  const errors: string[] = [];
  const changes: string[] = [];
  locked(
    ["bounds", "adamPreferences", "learning", "publishDays", "window"],
    previous,
    next,
    errors,
  );
  const bounds = previous.bounds ?? {};
  const prefs = previous.adamPreferences ?? {};

  const ranged: Array<[string, unknown, number[] | undefined]> = [
    ["minScore", next.minScore, bounds.minScore],
    ["minHotChance", next.minHotChance, bounds.minHotChance],
    ["perDay.max", next.perDay?.max, bounds.perDayMax],
    [
      "maxPerCategoryPerDay",
      next.maxPerCategoryPerDay,
      bounds.maxPerCategoryPerDay,
    ],
  ];
  for (const [label, value, range] of ranged) {
    if (range && !inRange(value, range)) {
      errors.push(`${label} = ${value} hors des bornes [${range.join(", ")}]`);
    }
  }
  if (
    !isNum(next.perDay?.min) ||
    next.perDay.min < 0 ||
    next.perDay.min > (next.perDay?.max ?? 0)
  ) {
    errors.push("perDay.min doit être entre 0 et perDay.max");
  }
  if (!isNum(next.minGapMinutes) || next.minGapMinutes < 15) {
    errors.push("minGapMinutes doit être ≥ 15");
  }

  for (const group of ["categoryAdjust", "sourceAdjust", "priceBandAdjust"]) {
    const map = next[group] ?? {};
    if (!isObj(map)) {
      errors.push(`${group} doit être un objet`);
      continue;
    }
    for (const [key, value] of Object.entries(map)) {
      if (bounds.adjust && !inRange(value, bounds.adjust)) {
        errors.push(
          `${group}.${key} = ${value} hors des bornes [${bounds.adjust.join(", ")}]`,
        );
      }
    }
  }
  for (const [key, max] of Object.entries(prefs.categoryAdjustMax ?? {})) {
    const value = next.categoryAdjust?.[key];
    if (!isNum(value) || value > (max as number)) {
      errors.push(`categoryAdjust.${key} doit rester ≤ ${max} (choix d'Adam)`);
    }
  }
  for (const [key, min] of Object.entries(prefs.categoryAdjustMin ?? {})) {
    const value = next.categoryAdjust?.[key];
    if (!isNum(value) || value < (min as number)) {
      errors.push(`categoryAdjust.${key} doit rester ≥ ${min} (choix d'Adam)`);
    }
  }
  for (const [key, min] of Object.entries(prefs.sourceAdjustMin ?? {})) {
    const value = next.sourceAdjust?.[key];
    if (!isNum(value) || value < (min as number)) {
      errors.push(`sourceAdjust.${key} doit rester ≥ ${min} (choix d'Adam)`);
    }
  }
  for (const [key, max] of Object.entries(prefs.categoryCapsMax ?? {})) {
    const value = next.categoryCaps?.[key];
    if (!isNum(value) || value > (max as number)) {
      errors.push(`categoryCaps.${key} doit rester ≤ ${max} (choix d'Adam)`);
    }
  }
  for (const value of Object.values(next.categoryCaps ?? {})) {
    if (!isNum(value) || value < 0) {
      errors.push("categoryCaps : valeurs ≥ 0 uniquement");
      break;
    }
  }
  if (
    !Array.isArray(next.excludedSources) ||
    next.excludedSources.some((s: unknown) => typeof s !== "string")
  ) {
    errors.push("excludedSources doit être une liste de sources");
  }

  for (const key of [
    "minScore",
    "minHotChance",
    "perDay",
    "minGapMinutes",
    "maxPerCategoryPerDay",
    "shortlistPerCategory",
    "excludedSources",
  ]) {
    diffValues(key, previous[key], next[key], changes);
  }
  for (const group of [
    "categoryCaps",
    "categoryAdjust",
    "sourceAdjust",
    "priceBandAdjust",
  ]) {
    diffMap(group, previous[group] ?? {}, next[group] ?? {}, changes);
  }
  return { errors, changes };
}

/** `config/desirability.json` (deals-debrief, daily). */
export function checkDesirability(previous: Json, next: Json): ConfigCheck {
  const errors: string[] = [];
  const changes: string[] = [];
  locked(["bounds", "maxDailyStep"], previous, next, errors);
  const bounds: number[] = previous.bounds ?? [-1.5, 1.5];
  const step: number = previous.maxDailyStep ?? 0.2;

  if (!inRange(next.noBrandPenalty, bounds)) {
    errors.push(`noBrandPenalty hors des bornes [${bounds.join(", ")}]`);
  } else if (
    Math.abs(next.noBrandPenalty - (previous.noBrandPenalty ?? 0)) >
    step + 1e-9
  ) {
    errors.push(`noBrandPenalty bouge de plus de ${step}`);
  }
  diffValues(
    "noBrandPenalty",
    previous.noBrandPenalty,
    next.noBrandPenalty,
    changes,
  );
  diffValues(
    "noBrandCategories",
    previous.noBrandCategories,
    next.noBrandCategories,
    changes,
  );

  // Every weight map in the file (brands, productTypes, …).
  const groups = new Set(
    [...Object.keys(previous), ...Object.keys(next)].filter(
      (key) =>
        (isObj(previous[key]) || isObj(next[key])) &&
        !["bounds", "$comment"].includes(key),
    ),
  );
  let moved = 0;
  for (const group of groups) {
    const before: Json = previous[group] ?? {};
    const after: Json = next[group] ?? {};
    if (!isObj(after)) {
      errors.push(`${group} doit être un objet`);
      continue;
    }
    for (const key of Object.keys(before)) {
      if (!(key in after)) errors.push(`${group}.${key} supprimé (interdit)`);
    }
    for (const [key, value] of Object.entries(after)) {
      if (!isNum(value) && !isNum(before[key])) continue; // nested notes
      const old = isNum(before[key]) ? before[key] : 0;
      if (!inRange(value, bounds)) {
        errors.push(
          `${group}.${key} = ${value} hors des bornes [${bounds.join(", ")}]`,
        );
      } else if (Math.abs(value - old) > step + 1e-9) {
        errors.push(
          `${group}.${key} bouge de ${old} à ${value} (pas maximal ${step})`,
        );
      }
      if (!same(before[key], value)) {
        moved++;
        changes.push(
          `${group}.${key}: ${JSON.stringify(before[key]) ?? "∅"} → ${value}`,
        );
      }
    }
  }
  if (moved > DESIRABILITY_MAX_KEYS_PER_WRITE) {
    errors.push(
      `${moved} poids modifiés d'un coup (max ${DESIRABILITY_MAX_KEYS_PER_WRITE})`,
    );
  }
  return { errors, changes };
}

/** `config/collection.json` (deals-sources, daily). */
export function checkCollection(previous: Json, next: Json): ConfigCheck {
  const errors: string[] = [];
  const changes: string[] = [];
  locked(["lockedSources"], previous, next, errors);
  const lockedSources: string[] = previous.lockedSources ?? [];

  for (const shop of ["amazon", "cdiscount"]) {
    const before: Json = previous[shop] ?? {};
    const after: Json = next[shop] ?? {};
    if (!same(before.bounds, after.bounds)) {
      errors.push(`${shop}.bounds est verrouillé`);
    }
    if (before.bounds && !inRange(after.limit, before.bounds)) {
      errors.push(
        `${shop}.limit = ${after.limit} hors des bornes [${before.bounds.join(", ")}]`,
      );
    }
    diffValues(`${shop}.limit`, before.limit, after.limit, changes);
    const pagesBefore: Json = before.extraPages ?? {};
    const pagesAfter: Json = after.extraPages ?? {};
    if (
      !same(Object.keys(pagesBefore).sort(), Object.keys(pagesAfter).sort())
    ) {
      errors.push(
        `${shop}.extraPages : les pages vérifiées ne s'ajoutent ni ne se retirent par un agent`,
      );
    }
    for (const [key, page] of Object.entries(pagesAfter)) {
      if (!isObj(page) || page.url !== pagesBefore[key]?.url) {
        errors.push(`${shop}.extraPages.${key} : URL verrouillée`);
      } else if (typeof page.enabled !== "boolean") {
        errors.push(`${shop}.extraPages.${key}.enabled doit être un booléen`);
      }
      diffValues(
        `${shop}.extraPages.${key}.enabled`,
        pagesBefore[key]?.enabled,
        isObj(page) ? page.enabled : undefined,
        changes,
      );
    }
  }

  const sourcesBefore: Json = previous.sources ?? {};
  const sourcesAfter: Json = next.sources ?? {};
  if (!isObj(sourcesAfter)) errors.push("sources doit être un objet");
  for (const [id, entry] of Object.entries(sourcesAfter)) {
    if (!isObj(entry)) {
      errors.push(`sources.${id} doit être un objet`);
      continue;
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
      errors.push(`sources.${id}.enabled doit être un booléen`);
    }
    if (entry.enabled === false && lockedSources.includes(id)) {
      errors.push(`sources.${id} est verrouillée (jamais coupée)`);
    }
    if (
      entry.everyHours !== undefined &&
      (!Number.isInteger(entry.everyHours) ||
        !inRange(entry.everyHours, SOURCE_EVERY_HOURS_BOUNDS))
    ) {
      errors.push(
        `sources.${id}.everyHours doit être un entier entre ${SOURCE_EVERY_HOURS_BOUNDS.join(" et ")}`,
      );
    }
  }
  for (const id of new Set([
    ...Object.keys(sourcesBefore),
    ...Object.keys(sourcesAfter),
  ])) {
    diffValues(`sources.${id}`, sourcesBefore[id], sourcesAfter[id], changes);
  }
  return { errors, changes };
}

/** `config/selection-lessons.md`: free text, size-capped. */
export function checkLessons(previous: string, next: string): ConfigCheck {
  const errors: string[] = [];
  if (Buffer.byteLength(next, "utf8") > LESSONS_MAX_BYTES) {
    errors.push(`leçons trop longues (max ${LESSONS_MAX_BYTES} octets)`);
  }
  if (!next.trim()) errors.push("leçons vides");
  const before = new Set(previous.split("\n"));
  const after = new Set(next.split("\n"));
  const added = [...after].filter((l) => l.trim() && !before.has(l)).length;
  const removed = [...before].filter((l) => l.trim() && !after.has(l)).length;
  return {
    errors,
    changes: added || removed ? [`+${added} / -${removed} lignes`] : [],
  };
}

/**
 * Checks a new version of an agent-tuned file against the current one.
 * JSON files must parse to an object; version/updatedAt/updatedBy are free.
 */
export function checkAgentConfig(
  name: AgentConfigName,
  previousText: string,
  nextText: string,
): ConfigCheck {
  if (name === "selection-lessons") return checkLessons(previousText, nextText);
  let previous: Json;
  let next: Json;
  try {
    previous = JSON.parse(previousText);
  } catch {
    return {
      errors: ["le fichier actuel n'est pas du JSON valide"],
      changes: [],
    };
  }
  try {
    next = JSON.parse(nextText);
  } catch (error) {
    return {
      errors: [`JSON invalide : ${(error as Error).message}`],
      changes: [],
    };
  }
  if (!isObj(next))
    return { errors: ["un objet JSON est attendu"], changes: [] };
  if (name === "publish-rules") return checkPublishRules(previous, next);
  if (name === "desirability") return checkDesirability(previous, next);
  return checkCollection(previous, next);
}

/**
 * Files under `data/agents/` the agents may write through the API: daily
 * outputs of `scripts/agents/dealradar.mjs` and their reports. Anything
 * else — another folder, `..`, a different extension — is refused.
 */
export const AGENT_DATA_FILE =
  /^(report|shortlist|queue|plan|published|stats|tune-stats|profile-review|sources-review|notion-plan|notion-final)-\d{4}-\d{2}-\d{2}\.json$/;
export const AGENT_REPORT_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;
export const AGENT_DATA_MAX_BYTES = 2_000_000;
