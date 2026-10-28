import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { $env, $inject, type Infer, z } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";
import { HttpError } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { publishScheduleEntity } from "../entities/PublishSchedule.ts";
import { AgentFilesService, writeAtomic } from "./AgentFilesService.ts";
import { appDir } from "./appDir.ts";
import {
  AutoPublishService,
  DealNotAvailableError,
  PublishRefusedError,
} from "./AutoPublishService.ts";
import { DealabsDraftService } from "./DealabsDraftService.ts";
import { DealabsDuplicateError } from "./DealabsPublisherService.ts";
import { DealabsSessionService } from "./DealabsSessionService.ts";
import { DealPageCheckService } from "./DealPageCheckService.ts";
import {
  atParis,
  HHMM,
  parisDay,
  parisTime,
  parisWeekday,
  randomTimes,
} from "./publishPlan.ts";

export type ScheduleEntry = Infer<typeof publishScheduleEntity.schema>;

/** A deal of tonight's ranked list, as the selector wrote it. */
export interface QueueCandidate {
  dealId: string;
  title?: string;
  sourceId?: string;
  categoryId?: string;
  price?: number;
  [key: string]: unknown;
}

interface LedgerEntry {
  date: string;
  at: string;
  slot?: string;
  dealId: string;
  categoryId?: string;
  result: string;
  [key: string]: unknown;
}

/** Deals tried per planned time: the one in line plus the next ones. */
export const MAX_TRIES_PER_SLOT = 4;
/** An entry this late (server down, long collection…) is skipped. */
export const STALE_AFTER_MS = 3 * 60 * 60 * 1000;
/** A `running` entry older than this was cut short (restart, crash). */
const RUNNING_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_QUEUE = 30;

export interface PlanInput {
  ranked: QueueCandidate[];
  /** HH:MM, Paris. Drawn in the rules' window when omitted. */
  times?: string[];
  /** Publish right away, a few minutes apart (manual test). */
  now?: boolean;
  /** Only check each merchant page, never publish. */
  dryRun?: boolean;
  agent: string;
  reason?: string;
}

/**
 * Tonight's publishing plan, run by the app itself so nothing has to wait
 * on Adam's PC: an agent hands over the ranked deals (`PUT
 * /agent/schedule`), the app draws the times like `dealradar.mjs
 * publish-queue` did — in the rules' window, `minGapMinutes` apart, a count
 * between `perDay.min` and `perDay.max` — and `PublishScheduleJob`, every
 * few minutes, runs the entries that are due through
 * `AutoPublishService.publishDeal` (duplicate check, merchant page check,
 * attempt recorded on the draft).
 *
 * Same rules as the script: up to {@link MAX_TRIES_PER_SLOT} deals per
 * time (a duplicate or an unavailable page moves to the next one), never
 * a deal already tried today, the per-category caps, at most
 * `perDay.max` posts a day, and never more than `AUTO_PUBLISH_MAX_PER_DAY`
 * entries. Results go to `data/agents/ledger.jsonl` in the script's format
 * so the Agents page, the debrief and the stats read them unchanged.
 */
export class PublishScheduleService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected entries = $repository(publishScheduleEntity);
  protected deals = $repository(dealEntity);
  protected files = $inject(AgentFilesService);
  protected publisher = $inject(AutoPublishService);
  protected drafts = $inject(DealabsDraftService);
  protected session = $inject(DealabsSessionService);
  protected pageCheck = $inject(DealPageCheckService);
  protected env = $env(
    z.object({
      AUTO_PUBLISH_MAX_PER_DAY: z.number().default(6),
    }),
  );

  protected running = false;

  protected now(): Date {
    return new Date(this.dateTime.nowISOString());
  }

  protected agentsDir(): string {
    return join(appDir(), "data", "agents");
  }

  protected rules(): Record<string, any> {
    return JSON.parse(this.files.readConfig("publish-rules"));
  }

  protected ledger(day: string): LedgerEntry[] {
    const file = join(this.agentsDir(), "ledger.jsonl");
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LedgerEntry];
        } catch {
          return [];
        }
      })
      .filter((entry) => entry.date === day);
  }

  protected appendLedger(entry: LedgerEntry): void {
    mkdirSync(this.agentsDir(), { recursive: true });
    appendFileSync(
      join(this.agentsDir(), "ledger.jsonl"),
      `${JSON.stringify(entry)}\n`,
    );
  }

  protected queueFile(day: string): string {
    return join(this.agentsDir(), `queue-${day}.json`);
  }

  readQueue(day: string): QueueCandidate[] {
    const file = this.queueFile(day);
    if (!existsSync(file)) return [];
    try {
      const queue = JSON.parse(readFileSync(file, "utf8"));
      return queue.ranked ?? [...(queue.items ?? []), ...(queue.backups ?? [])];
    } catch {
      return [];
    }
  }

  async list(day = parisDay(this.now())) {
    const entries = await this.entries.findMany({
      where: { date: { eq: day } },
      orderBy: { column: "plannedAt", direction: "asc" },
    });
    return { date: day, entries, queue: this.readQueue(day) };
  }

  /** Replaces today's planned entries with a new plan. */
  async plan(input: PlanInput) {
    const now = this.now();
    const day = parisDay(now);
    const r = this.rules();
    if (!input.dryRun && !r.publishDays?.includes(parisWeekday(now))) {
      throw new HttpError({
        status: 409,
        message: "Pas de publication ce jour (publishDays).",
      });
    }
    if (input.ranked.length === 0 || input.ranked.length > MAX_QUEUE) {
      throw new HttpError({
        status: 422,
        message: `Entre 1 et ${MAX_QUEUE} deals classés attendus.`,
      });
    }

    // Our own data wins over what the agent copied (title, price…).
    const ranked: QueueCandidate[] = [];
    const dropped: string[] = [];
    for (const candidate of input.ranked) {
      const deal = await this.deals
        .findById(candidate.dealId)
        .catch(() => null);
      if (!deal || deal.status !== "active") {
        dropped.push(candidate.dealId);
        continue;
      }
      if (ranked.some((c) => c.dealId === deal.id)) continue;
      ranked.push({
        ...candidate,
        dealId: deal.id,
        title: deal.title,
        sourceId: deal.sourceId,
        categoryId: deal.categoryId,
        price: deal.currentPrice,
        url: deal.url,
      });
    }
    if (ranked.length === 0) {
      throw new HttpError({
        status: 422,
        message: "Aucun deal actif dans la liste.",
      });
    }

    const done = this.ledger(day).filter((e) => e.result === "success").length;
    const perDayMax = Math.min(r.perDay.max, this.env.AUTO_PUBLISH_MAX_PER_DAY);
    const room = Math.max(0, perDayMax - done);

    let times: Date[];
    if (input.now) {
      times = Array.from(
        { length: Math.min(room, ranked.length) },
        (_, i) => new Date(now.getTime() + (1 + i * 2) * 60_000),
      );
    } else if (input.times?.length) {
      const windowStart = atParis(day, r.window.start).getTime();
      const windowEnd = atParis(day, r.window.end).getTime();
      times = [];
      for (const hhmm of [...input.times].sort()) {
        if (!HHMM.test(hhmm)) {
          throw new HttpError({
            status: 422,
            message: `Heure invalide : ${hhmm}`,
          });
        }
        const at = atParis(day, hhmm);
        if (at.getTime() < now.getTime()) {
          throw new HttpError({
            status: 422,
            message: `${hhmm} est déjà passé`,
          });
        }
        if (
          !input.dryRun &&
          (at.getTime() < windowStart || at.getTime() > windowEnd)
        ) {
          throw new HttpError({
            status: 422,
            message: `${hhmm} hors de la fenêtre ${r.window.start}–${r.window.end}`,
          });
        }
        times.push(at);
      }
      if (times.length > room) {
        throw new HttpError({
          status: 422,
          message: `${times.length} heures pour ${room} publication(s) possibles aujourd'hui`,
        });
      }
    } else {
      const drawn =
        r.perDay.min +
        Math.floor(Math.random() * (r.perDay.max - r.perDay.min + 1));
      const count = Math.min(Math.max(0, drawn - done), room, ranked.length);
      times = randomTimes(
        count,
        new Date(
          Math.max(
            atParis(day, r.window.start).getTime(),
            now.getTime() + 5 * 60_000,
          ),
        ),
        atParis(day, r.window.end),
        r.minGapMinutes,
      );
    }

    const replaced = await this.entries.findMany({
      where: { and: [{ date: { eq: day } }, { status: { eq: "planned" } }] },
    });
    for (const entry of replaced) {
      await this.entries.updateById(entry.id, {
        status: "cancelled",
        note: `remplacé par le plan de ${input.agent}`,
      });
    }
    const created: ScheduleEntry[] = [];
    for (const at of times) {
      created.push(
        await this.entries.create({
          date: day,
          plannedAt: at.toISOString(),
          status: "planned",
          dryRun: input.dryRun ?? false,
          preparedBy: input.agent.slice(0, 80),
          note: input.reason?.slice(0, 2000),
        }),
      );
    }

    writeAtomic(
      this.queueFile(day),
      JSON.stringify({
        date: day,
        preparedBy: input.agent,
        reason: input.reason,
        ranked,
      }),
    );
    if (!input.dryRun) {
      writeAtomic(
        join(this.agentsDir(), `plan-${day}.json`),
        JSON.stringify({
          date: day,
          target: times.length,
          times: times.map(parisTime),
          planned: ranked.slice(0, times.length).map((c) => c.dealId),
          preparedBy: input.agent,
        }),
      );
    }
    await this.files.audit({
      agent: input.agent,
      kind: "schedule",
      target: `plan-${day}`,
      reason: input.reason,
      summary: [
        `${times.length} publication(s) : ${times.map(parisTime).join(", ") || "aucune"}`,
        `${ranked.length} deal(s) classés${dropped.length ? `, ${dropped.length} écarté(s) (inactifs)` : ""}`,
        input.dryRun ? "essai à blanc (aucune publication)" : "",
      ]
        .filter(Boolean)
        .join("\n"),
    });
    return { date: day, entries: created, ranked: ranked.length, dropped };
  }

  async cancel(id: string, by: string) {
    const entry = await this.entries.getById(id);
    if (entry.status !== "planned") {
      throw new HttpError({ status: 409, message: `Déjà ${entry.status}.` });
    }
    await this.files.audit({
      agent: by,
      kind: "schedule",
      target: `plan-${entry.date}`,
      summary: `annulé : ${parisTime(new Date(entry.plannedAt))}`,
    });
    return this.entries.updateById(id, {
      status: "cancelled",
      note: `annulé par ${by}`,
    });
  }

  async reschedule(id: string, hhmm: string, by: string) {
    const entry = await this.entries.getById(id);
    if (entry.status !== "planned") {
      throw new HttpError({ status: 409, message: `Déjà ${entry.status}.` });
    }
    if (!HHMM.test(hhmm)) {
      throw new HttpError({ status: 422, message: `Heure invalide : ${hhmm}` });
    }
    const at = atParis(entry.date, hhmm);
    if (at.getTime() < this.now().getTime()) {
      throw new HttpError({ status: 422, message: `${hhmm} est déjà passé` });
    }
    await this.files.audit({
      agent: by,
      kind: "schedule",
      target: `plan-${entry.date}`,
      summary: `déplacé : ${parisTime(new Date(entry.plannedAt))} → ${hhmm}`,
    });
    return this.entries.updateById(id, { plannedAt: at.toISOString() });
  }

  /** Runs every due entry, one at a time (called by `PublishScheduleJob`). */
  async runDue(): Promise<ScheduleEntry[]> {
    if (this.running) return [];
    this.running = true;
    const ran: ScheduleEntry[] = [];
    try {
      const now = this.now();
      const stuck = await this.entries.findMany({
        where: { status: { eq: "running" } },
      });
      for (const entry of stuck) {
        if (
          now.getTime() - new Date(entry.updatedAt).getTime() >
          RUNNING_TIMEOUT_MS
        ) {
          await this.entries.updateById(entry.id, {
            status: "failed",
            note: "interrompu (redémarrage ?)",
          });
        }
      }
      const due = (
        await this.entries.findMany({
          where: {
            and: [
              { status: { eq: "planned" } },
              { plannedAt: { lte: now.toISOString() } },
            ],
          },
          orderBy: { column: "plannedAt", direction: "asc" },
        })
      ).filter((e) => new Date(e.plannedAt).getTime() <= now.getTime());
      for (const entry of due) {
        ran.push(await this.execute(entry));
      }
    } finally {
      this.running = false;
    }
    return ran;
  }

  protected async finish(
    entry: ScheduleEntry,
    patch: Partial<ScheduleEntry>,
  ): Promise<ScheduleEntry> {
    return this.entries.updateById(entry.id, {
      ...patch,
      executedAt: this.dateTime.nowISOString(),
    });
  }

  protected async execute(entry: ScheduleEntry): Promise<ScheduleEntry> {
    const now = this.now();
    const late = now.getTime() - new Date(entry.plannedAt).getTime();
    if (entry.date !== parisDay(now) || late > STALE_AFTER_MS) {
      return this.finish(entry, {
        status: "skipped",
        note: "trop tard (le serveur était occupé ou arrêté à l'heure prévue)",
      });
    }
    const r = this.rules();
    const slot = parisTime(new Date(entry.plannedAt));
    const todays = this.ledger(entry.date);
    const success = () => todays.filter((e) => e.result === "success");
    const perDayMax = Math.min(r.perDay.max, this.env.AUTO_PUBLISH_MAX_PER_DAY);
    if (!entry.dryRun && success().length >= perDayMax) {
      return this.finish(entry, {
        status: "skipped",
        note: `déjà ${success().length} publication(s) aujourd'hui (max ${perDayMax})`,
      });
    }
    if (!entry.dryRun) {
      const session = this.session.status();
      if (!session.available || !session.connected) {
        return this.finish(entry, {
          status: "skipped",
          note: session.available
            ? "pas de session Dealabs (« Se connecter à Dealabs » sur une fiche deal)"
            : "publication impossible sur ce serveur",
        });
      }
      if (this.publisher.isBusy) {
        return entry; // the button is publishing: next tick
      }
    }

    await this.entries.updateById(entry.id, { status: "running" });
    const others = await this.entries.findMany({
      where: { date: { eq: entry.date } },
    });
    const tried = new Set<string>([
      ...todays.map((e) => e.dealId),
      ...others
        .filter((e) => e.id !== entry.id && e.dealId)
        .map((e) => e.dealId!),
    ]);

    const outcomes: string[] = [];
    let attempts = 0;
    let anyFailed = false;
    for (const candidate of this.readQueue(entry.date)) {
      if (attempts >= MAX_TRIES_PER_SLOT) break;
      if (tried.has(candidate.dealId)) continue;
      const cap =
        r.categoryCaps?.[candidate.categoryId ?? ""] ?? r.maxPerCategoryPerDay;
      const sameCategory = success().filter(
        (e) => e.categoryId === candidate.categoryId,
      ).length;
      if (candidate.categoryId && sameCategory >= cap) continue;
      const deal = await this.deals
        .findById(candidate.dealId)
        .catch(() => null);
      if (!deal || deal.status !== "active") {
        tried.add(candidate.dealId);
        continue;
      }
      attempts++;
      tried.add(deal.id);

      if (entry.dryRun) {
        const verdict = this.pageCheck.enabled
          ? await this.pageCheck.check(deal).catch((error: unknown) => ({
              ok: false,
              reason: String(error).slice(0, 300),
            }))
          : { ok: true, reason: "vérification de page désactivée" };
        return this.finish(entry, {
          status: "done",
          result: "dry-run",
          dealId: deal.id,
          title: deal.title,
          note: verdict.ok
            ? `essai à blanc : serait publié (${"reason" in verdict ? verdict.reason : "page du marchand OK"})`
            : `essai à blanc : page refusée — ${"reason" in verdict ? verdict.reason : ""}`,
        });
      }

      let result: "success" | "duplicate" | "unavailable" | "failed";
      let url: string | undefined;
      let error: string | undefined;
      try {
        await this.drafts.ensureDraftForDeal(deal.id);
        const draft = await this.publisher.publishDeal(deal.id);
        result = "success";
        url = draft.dealabsUrl;
      } catch (thrown) {
        error = (
          thrown instanceof Error ? thrown.message : String(thrown)
        ).slice(0, 300);
        result =
          thrown instanceof DealabsDuplicateError
            ? "duplicate"
            : thrown instanceof DealNotAvailableError ||
                (thrown instanceof PublishRefusedError && thrown.status === 404)
              ? "unavailable"
              : thrown instanceof PublishRefusedError
                ? "duplicate"
                : "failed";
        if (result === "failed") anyFailed = true;
      }
      const ledgerEntry: LedgerEntry = {
        date: entry.date,
        at: this.dateTime.nowISOString(),
        slot,
        ...candidate,
        dealId: deal.id,
        title: deal.title,
        sourceId: deal.sourceId,
        categoryId: deal.categoryId,
        price: deal.currentPrice,
        result,
        url,
        error,
        by: "app",
      };
      this.appendLedger(ledgerEntry);
      todays.push(ledgerEntry);
      outcomes.push(
        `${result} : ${deal.title.slice(0, 80)}${error ? ` (${error.slice(0, 120)})` : ""}`,
      );
      this.writePublished(entry.date);

      if (result === "success") {
        return this.finish(entry, {
          status: "done",
          result,
          dealId: deal.id,
          title: deal.title,
          dealabsUrl: url,
          note: outcomes.join("\n"),
        });
      }
      await this.entries.updateById(entry.id, {
        dealId: deal.id,
        title: deal.title,
      });
    }
    return this.finish(entry, {
      status: anyFailed ? "failed" : "skipped",
      result: attempts > 0 ? (anyFailed ? "failed" : "unavailable") : undefined,
      note:
        outcomes.join("\n") ||
        "aucun deal restant dans la liste (déjà essayés, plafonds par catégorie ou inactifs)",
    });
  }

  /** `published-<date>.json`, read by `dealradar.mjs notion-log final`. */
  protected writePublished(day: string): void {
    const planFile = join(this.agentsDir(), `plan-${day}.json`);
    const plan = existsSync(planFile)
      ? JSON.parse(readFileSync(planFile, "utf8"))
      : { date: day };
    writeAtomic(
      join(this.agentsDir(), `published-${day}.json`),
      JSON.stringify({ date: day, plan, results: this.ledger(day) }, null, 2),
    );
  }
}
