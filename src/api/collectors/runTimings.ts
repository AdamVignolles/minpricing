import { loadavg } from "node:os";

/** Where a source's run time went, written to the run journal. */
export interface RunTiming {
  listingMs?: number;
  pagesMs?: number;
  candidates?: number;
  pagesRead?: number;
  /** Product pages that gave no price (challenge, timeout, layout). */
  pagesFailed?: number;
  /** Pages read over plain HTTP; the rest needed the browser. */
  readByFetch?: number;
  skippedUnchanged?: number;
  pageP50Ms?: number;
  pageP95Ms?: number;
  /** 1-minute load average when the source started and ended. */
  load?: [number, number];
}

const timings = new Map<string, RunTiming>();

export function noteTiming(source: string, timing: RunTiming): void {
  timings.set(source, { ...timings.get(source), ...timing });
}

/** Timings noted since the last call, per source. */
export function takeTimings(): Record<string, RunTiming> {
  const out = Object.fromEntries(timings);
  timings.clear();
  return out;
}

export function currentLoad(): number {
  return Math.round(loadavg()[0] * 10) / 10;
}

export function percentile(values: number[], p: number): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}
