import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  type AgentWriteRow,
  ROUTINES,
  type RoutineHealth,
  routineHealth,
} from "./agentHealth.ts";
import { appDir } from "./appDir.ts";

/**
 * What the local agents did, read from the files they write
 * (`data/agents/`, `config/`, `docs/*changelog.md`) for the console's
 * Agents page. Read-only; on Workers (no such files) everything is empty.
 */

export interface WeightRow {
  key: string;
  value: number;
}

export interface AgentDay {
  date: string;
  times: string[];
  planned: number;
  published: number;
  ignored: number;
  duplicates: number;
  failed: number;
}

export interface AgentPost {
  date: string;
  time: string;
  title: string;
  url?: string;
  sourceId?: string;
  categoryId?: string;
  price?: number;
  result: string;
  reason?: string;
  temperature?: number;
}

export interface AgentLesson {
  rule: string;
  proof: string;
  addedAt?: string;
}

export interface ChangelogEntry {
  source: string;
  title: string;
  body: string;
}

export interface AgentReportSummary {
  id: string;
  type: "soiree" | "debrief" | "bilan" | "sources" | "autre";
  date: string;
  title: string;
  summary?: string;
}

const root = () => appDir();
const agentsDir = () => join(root(), "data", "agents");
const reportsDir = () => join(agentsDir(), "reports");

function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

const rows = (record: Record<string, number> | undefined): WeightRow[] =>
  Object.entries(record ?? {})
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value);

interface LedgerEntry {
  date: string;
  at: string;
  dealId: string;
  title: string;
  sourceId?: string;
  categoryId?: string;
  price?: number;
  result: string;
  url?: string;
  error?: string;
  reason?: string;
}

export class AgentsService {
  protected ledger(days = 30): LedgerEntry[] {
    const since = Date.now() - days * 86_400_000;
    return readText(join(agentsDir(), "ledger.jsonl"))
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return [];
        }
      })
      .filter((entry) => new Date(entry.at).getTime() >= since);
  }

  /** Temperatures of our posts, from the newest saved agent report. */
  protected temperatures(): Map<string, number> {
    const files = existsSync(agentsDir())
      ? readdirSync(agentsDir())
          .filter((f) => /^report-\d{4}-\d{2}-\d{2}\.json$/.test(f))
          .sort()
      : [];
    const map = new Map<string, number>();
    for (const file of files.slice(-3)) {
      const report = readJson<{
        posted?: Array<{ dealId: string; temperature?: number }>;
      }>(join(agentsDir(), file));
      for (const post of report?.posted ?? []) {
        if (post.temperature !== undefined)
          map.set(post.dealId, post.temperature);
      }
    }
    return map;
  }

  overview() {
    const ledger = this.ledger(30);
    const temps = this.temperatures();
    const since14 = Date.now() - 14 * 86_400_000;
    const recent = ledger.filter((e) => new Date(e.at).getTime() >= since14);

    const byDay = new Map<string, AgentDay>();
    for (const entry of recent) {
      const day = byDay.get(entry.date) ?? {
        date: entry.date,
        times: [],
        planned: 0,
        published: 0,
        ignored: 0,
        duplicates: 0,
        failed: 0,
      };
      if (entry.result === "success") day.published++;
      else if (entry.result === "duplicate") day.duplicates++;
      else if (entry.result === "unavailable" || entry.result === "skipped")
        day.ignored++;
      else day.failed++;
      byDay.set(entry.date, day);
    }
    for (const day of byDay.values()) {
      const plan = readJson<{ times?: string[]; target?: number }>(
        join(agentsDir(), `plan-${day.date}.json`),
      );
      day.times = plan?.times ?? [];
      day.planned = plan?.target ?? day.times.length;
    }

    const published = recent.filter((e) => e.result === "success");
    const withTemp = published
      .map((e) => temps.get(e.dealId))
      .filter((t): t is number => t !== undefined)
      .sort((a, b) => a - b);

    const posts: AgentPost[] = recent
      .slice()
      .reverse()
      .slice(0, 30)
      .map((e) => ({
        date: e.date,
        time: new Date(e.at).toLocaleTimeString("fr-FR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Europe/Paris",
        }),
        title: e.title,
        url: e.url,
        sourceId: e.sourceId,
        categoryId: e.categoryId,
        price: e.price,
        result: e.result,
        reason: e.result === "success" ? e.reason : e.error,
        temperature: temps.get(e.dealId),
      }));

    const rules =
      readJson<Record<string, any>>(
        join(root(), "config", "publish-rules.json"),
      ) ?? {};
    const desirability =
      readJson<Record<string, any>>(
        join(root(), "config", "desirability.json"),
      ) ?? {};
    const collection =
      readJson<Record<string, any>>(
        join(root(), "config", "collection.json"),
      ) ?? {};
    const shop = (name: string) => ({
      limit: collection[name]?.limit ?? 0,
      bounds: (collection[name]?.bounds ?? [0, 0]) as number[],
      pages: Object.entries(
        (collection[name]?.extraPages ?? {}) as Record<
          string,
          { enabled: boolean }
        >,
      ).map(([key, page]) => ({ key, enabled: !!page.enabled })),
    });
    const prefs = (rules.adamPreferences ?? {}) as Record<
      string,
      Record<string, number>
    >;

    return {
      generatedAt: new Date().toISOString(),
      kpis: {
        published14d: published.length,
        attempted14d: recent.length,
        hot14d: withTemp.filter(
          (t) => t >= (rules.learning?.hotThreshold ?? 100),
        ).length,
        ...(withTemp.length
          ? { medianTemperature: withTemp[Math.floor(withTemp.length / 2)] }
          : {}),
        measured: withTemp.length,
      },
      days: [...byDay.values()].sort((a, b) => b.date.localeCompare(a.date)),
      posts,
      rules: {
        version: rules.version ?? 0,
        updatedAt: rules.updatedAt ?? "",
        updatedBy: rules.updatedBy ?? "",
        minScore: rules.minScore ?? 0,
        minHotChance: rules.minHotChance ?? 0,
        perDayMin: rules.perDay?.min ?? 0,
        perDayMax: rules.perDay?.max ?? 0,
        windowStart: rules.window?.start ?? "",
        windowEnd: rules.window?.end ?? "",
        publishDays: (rules.publishDays ?? []) as number[],
        maxPerCategoryPerDay: rules.maxPerCategoryPerDay ?? 0,
        categoryCaps: rows(rules.categoryCaps),
        excludedSources: (rules.excludedSources ?? []) as string[],
        categoryAdjust: rows(rules.categoryAdjust),
        sourceAdjust: rows(rules.sourceAdjust),
        locked: [
          ...Object.entries(prefs.categoryAdjustMax ?? {}).map(
            ([k, v]) => `${k} ≤ ${v}`,
          ),
          ...Object.entries(prefs.categoryAdjustMin ?? {}).map(
            ([k, v]) => `${k} ≥ +${v}`,
          ),
          ...Object.entries(prefs.sourceAdjustMin ?? {}).map(
            ([k, v]) => `${k} ≥ +${v}`,
          ),
          ...Object.entries(prefs.categoryCapsMax ?? {}).map(
            ([k, v]) => `${k} : ${v} par jour max`,
          ),
        ],
      },
      desirability: {
        version: desirability.version ?? 0,
        updatedAt: desirability.updatedAt ?? "",
        updatedBy: desirability.updatedBy ?? "",
        noBrandPenalty: desirability.noBrandPenalty ?? 0,
        knownBrands: Object.keys(desirability.brands ?? {}).length,
        brands: rows(desirability.brands).filter((row) => row.value !== 0),
        keywords: rows(desirability.keywords)
          .filter((row) => row.value !== 0)
          .map((row) => ({ ...row, key: row.key.split("|")[0] })),
      },
      collection: {
        amazon: shop("amazon"),
        cdiscount: shop("cdiscount"),
        sources: Object.entries(
          (collection.sources ?? {}) as Record<
            string,
            { enabled?: boolean; everyHours?: number }
          >,
        )
          .map(([id, source]) => ({
            id,
            enabled: source.enabled !== false,
            everyHours: source.everyHours ?? 1,
            locked: ((collection.lockedSources ?? []) as string[]).includes(id),
          }))
          .sort(
            (a, b) =>
              Number(b.locked) - Number(a.locked) || a.id.localeCompare(b.id),
          ),
      },
      lessons: this.lessons(),
      changelog: [
        ...this.changelog(
          join(root(), "docs", "publish-rules-changelog.md"),
          "Règles de sélection",
        ),
        ...this.changelog(
          join(root(), "docs", "desirability-changelog.md"),
          "Désirabilité & collecte",
        ),
        ...this.changelog(
          join(root(), "docs", "sources-changelog.md"),
          "Sources",
        ),
      ]
        .sort((a, b) =>
          (b.title.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "").localeCompare(
            a.title.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "",
          ),
        )
        .slice(0, 20),
    };
  }

  protected lessons(): AgentLesson[] {
    return readText(join(root(), "config", "selection-lessons.md"))
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- **"))
      .map((line) => {
        const rule = line.match(/^- \*\*(.+?)\*\*/)?.[1] ?? line;
        const rest = line.replace(/^- \*\*.+?\*\*\s*—?\s*/, "");
        const addedAt = rest.match(/ajoutée le (\d{4}-\d{2}-\d{2})/)?.[1];
        return {
          rule,
          proof: rest.replace(/\s*·\s*ajoutée le \d{4}-\d{2}-\d{2}\s*$/, ""),
          addedAt,
        };
      });
  }

  protected changelog(file: string, source: string): ChangelogEntry[] {
    return readText(file)
      .split(/^## /m)
      .slice(1)
      .map((block) => {
        const [title, ...body] = block.split(/\r?\n/);
        return { source, title: title.trim(), body: body.join("\n").trim() };
      });
  }

  health(now: Date, writes: AgentWriteRow[]): RoutineHealth[] {
    const mtimeOf = (path: string) => {
      const file = join(agentsDir(), path);
      return existsSync(file) ? statSync(file).mtime : undefined;
    };
    return ROUTINES.map((spec) => routineHealth(spec, now, mtimeOf, writes));
  }

  reports(): AgentReportSummary[] {
    if (!existsSync(reportsDir())) return [];
    return readdirSync(reportsDir())
      .filter((file) => file.endsWith(".md"))
      .map((file) => {
        const id = file.replace(/\.md$/, "");
        const text = readText(join(reportsDir(), file));
        const kind = id.split("-")[0];
        const type: AgentReportSummary["type"] =
          kind === "soiree" ||
          kind === "debrief" ||
          kind === "bilan" ||
          kind === "sources"
            ? kind
            : "autre";
        const summary =
          text.match(/^> (.+)$/m)?.[1] ??
          text
            .match(/<callout[^>]*>\s*([\s\S]*?)<\/callout>/)?.[1]
            ?.replace(/<[^>]+>/g, "")
            .trim();
        return {
          id,
          type,
          date: id.match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? "",
          title: text.match(/^# (.+)$/m)?.[1] ?? id,
          summary: summary?.slice(0, 400),
        };
      })
      .sort(
        (a, b) => b.date.localeCompare(a.date) || a.type.localeCompare(b.type),
      );
  }

  report(id: string): { id: string; markdown: string } | undefined {
    if (!/^[a-z]+-\d{4}-\d{2}-\d{2}$/.test(id)) return undefined;
    const file = join(reportsDir(), `${id}.md`);
    return existsSync(file) ? { id, markdown: readText(file) } : undefined;
  }
}
