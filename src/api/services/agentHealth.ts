/**
 * Health of the scheduled cloud routines (`.claude/schedules/schedules.json`):
 * each one must leave a dated file on the server after its slot. A slot
 * whose file never appeared (or is older than the slot) past the grace
 * time is "missed". Slots are in UTC, as the routines' crons are.
 */

export interface RoutineSpec {
  id: string;
  name: string;
  /** The agent name it writes as (`agent_writes.agent`). */
  agent: string;
  /** UTC days it runs (0 = Sunday). */
  days: number[];
  hourUtc: number;
  minuteUtc: number;
  /** The files it must leave for the slot's Paris day, under `data/agents/`. */
  evidence: (day: string) => string[];
}

export const ROUTINES: RoutineSpec[] = [
  {
    id: "selection",
    name: "Sélection du soir",
    agent: "deal-selector",
    days: [1, 2, 3, 4, 5],
    hourUtc: 16,
    minuteUtc: 0,
    evidence: (day) => [`queue-${day}.json`],
  },
  {
    id: "sources",
    name: "Revue des sources",
    agent: "sources-scout",
    days: [0, 1, 2, 3, 4, 5, 6],
    hourUtc: 16,
    minuteUtc: 30,
    evidence: (day) => [`reports/sources-${day}.md`],
  },
  {
    id: "bilan",
    name: "Bilan du soir",
    agent: "results-reviewer",
    days: [0, 1, 2, 3, 4, 5, 6],
    hourUtc: 21,
    minuteUtc: 15,
    evidence: (day) => [`reports/debrief-${day}.md`],
  },
  {
    id: "revue",
    name: "Revue des règles",
    agent: "results-reviewer",
    days: [0, 1, 2, 3, 4, 5, 6],
    hourUtc: 21,
    minuteUtc: 45,
    evidence: (day) => [`reports/bilan-${day}.md`],
  },
];

/** A routine may still be running this long after its slot. */
export const GRACE_MINUTES = 90;
/** Files written a little before the slot (a manual run) still count. */
const EARLY_MINUTES = 10;

export const parisDay = (date: Date): string =>
  date.toLocaleDateString("sv-SE", { timeZone: "Europe/Paris" });

/** The routine's most recent slot at or before `now`. */
export function lastSlot(spec: RoutineSpec, now: Date): Date {
  for (let back = 0; back <= 7; back++) {
    const slot = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - back,
        spec.hourUtc,
        spec.minuteUtc,
      ),
    );
    if (slot <= now && spec.days.includes(slot.getUTCDay())) return slot;
  }
  throw new Error(`no slot in the last week for ${spec.id}`);
}

export interface RoutineHealth {
  id: string;
  name: string;
  /** e.g. « lun.–ven. 17:00 » in Paris time. */
  schedule: string;
  lastSlot: string;
  /** Newest evidence file's time, if any for that slot. */
  lastRun?: string;
  status: "ok" | "running" | "missed";
  /** The evidence files present for the slot. */
  files: string[];
  /** Configs, proposals and schedules it wrote around that slot. */
  changes: string[];
}

export interface AgentWriteRow {
  agent: string;
  kind: string;
  target: string;
  createdAt: string | Date;
}

const DAY_NAMES = ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."];

function scheduleLabel(spec: RoutineSpec, now: Date): string {
  const sample = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      spec.hourUtc,
      spec.minuteUtc,
    ),
  );
  const time = sample.toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });
  const days =
    spec.days.length === 7
      ? "tous les jours"
      : spec.days.join() === "1,2,3,4,5"
        ? "lun.–ven."
        : spec.days.map((d) => DAY_NAMES[d]).join(", ");
  return `${days} ${time}`;
}

/**
 * `mtimeOf(path)` gives a file's modification time under `data/agents/`
 * (undefined when absent); `writes` are recent `agent_writes` rows.
 */
export function routineHealth(
  spec: RoutineSpec,
  now: Date,
  mtimeOf: (path: string) => Date | undefined,
  writes: AgentWriteRow[],
): RoutineHealth {
  const slot = lastSlot(spec, now);
  const from = slot.getTime() - EARLY_MINUTES * 60_000;
  const found = spec
    .evidence(parisDay(slot))
    .map((file) => ({ file, at: mtimeOf(file) }))
    .filter((f): f is { file: string; at: Date } => !!f.at && +f.at >= from);
  const lastRun = found.map((f) => f.at).sort((a, b) => +b - +a)[0];
  // Until the next routine of the same agent starts (bilan → revue).
  const next = ROUTINES.filter((r) => r.agent === spec.agent && r !== spec)
    .map((r) => {
      const s = lastSlot(r, new Date(slot.getTime() + 86_400_000));
      return s.getTime() > slot.getTime() ? s.getTime() : Infinity;
    })
    .concat(slot.getTime() + 3 * 3_600_000);
  const until = Math.min(...next) - EARLY_MINUTES * 60_000;
  const changes = writes
    .filter((w) => {
      const at = new Date(w.createdAt).getTime();
      return (
        w.agent.includes(spec.agent) &&
        ["config", "proposal", "schedule"].includes(w.kind) &&
        at >= from &&
        at < until
      );
    })
    .map((w) => `${w.kind} ${w.target}`);
  const status = lastRun
    ? "ok"
    : now.getTime() < slot.getTime() + GRACE_MINUTES * 60_000
      ? "running"
      : "missed";
  return {
    id: spec.id,
    name: spec.name,
    schedule: scheduleLabel(spec, now),
    lastSlot: slot.toISOString(),
    lastRun: lastRun?.toISOString(),
    status,
    files: found.map((f) => f.file),
    changes: [...new Set(changes)],
  };
}
