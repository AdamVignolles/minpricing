import { existsSync } from "node:fs";

import { $inject, Alepha, type Infer } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";

import { withBrowser } from "../collectors/browser.ts";
import { dealEntity } from "../entities/Deal.ts";
import { dealabsDraftEntity } from "../entities/DealabsDraft.ts";
import { AgentFilesService } from "./AgentFilesService.ts";
import {
  isFromModerators,
  learnFromRejection,
  MODERATION_REASON_LABELS,
  type ModerationMessage,
  type ModerationReason,
  type ModerationStatus,
  matchMessageToDraft,
  parseModerationMessage,
  threadPublicStatus,
  threadUrls,
} from "./dealabsModeration.ts";
import { SESSION_PATH } from "./DealabsPublisherService.ts";

type Draft = Infer<typeof dealabsDraftEntity.schema>;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "fr-FR,fr;q=0.9",
};
/** Our posts are watched this long after publication. */
const WATCH_DAYS = 21;
/** Threads read per pass, paced: Dealabs is read like a visitor would. */
const MAX_THREADS_PER_PASS = 15;
/** An alert stays on the banner this long unless Adam closes it. */
const ALERT_DAYS = 7;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** One hidden or deleted post, as the console and the MCP show it. */
export interface ModerationAlert {
  dealId: string;
  title: string;
  dealabsUrl?: string;
  status: ModerationStatus;
  reason: ModerationReason;
  label: string;
  message?: string;
  at?: string;
  /** When the moderators' deadline runs out, if their message gave one. */
  deadline?: string;
}

export interface ModerationStats {
  days: number;
  posts: number;
  rejected: number;
  /** Percentage of posts hidden or deleted. */
  rate: number;
  bySource: Record<string, { posts: number; rejected: number }>;
  byCategory: Record<string, { posts: number; rejected: number }>;
  byReason: Record<string, number>;
}

export interface ModerationPass {
  threads: number;
  messages: number;
  /** Drafts whose moderation changed in this pass. */
  changed: Array<{ dealId: string; status: ModerationStatus; reason: string }>;
  /** Why the messages couldn't be read, when they couldn't. */
  messagesSkipped?: string;
  learned: string[];
}

/**
 * Watches our Dealabs posts after publication (epic 29): reads each
 * recent thread's public page (gone = hidden or deleted) and, with the
 * saved session, the account's messages from « L'équipe Dealabs », then
 * files the outcome on the draft and teaches the « Prêt pour Dealabs »
 * checklist (`config/moderation.json`). Read only: never replies to a
 * moderator, never edits a post (owner's decision, 2026-11-04).
 */
export class DealabsModerationService {
  protected log = $logger();
  protected alepha = $inject(Alepha);
  protected dateTime = $inject(DateTimeProvider);
  protected drafts = $repository(dealabsDraftEntity);
  protected deals = $repository(dealEntity);
  protected agentFiles = $inject(AgentFilesService);

  protected running?: Promise<ModerationPass>;

  /** Posted drafts still watched, newest first. */
  protected async watched(): Promise<Draft[]> {
    const since =
      new Date(this.dateTime.nowISOString()).getTime() -
      WATCH_DAYS * 24 * 3600_000;
    return (await this.drafts.findMany({ where: { status: { eq: "posted" } } }))
      .filter(
        (draft) =>
          draft.dealabsUrl &&
          new Date(
            draft.verifiedAt ?? draft.lastPublishAttemptAt ?? draft.updatedAt,
          ).getTime() >= since,
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  /** One pass (the job, every 20 min); concurrent calls share it. */
  poll(): Promise<ModerationPass> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  protected async pass(): Promise<ModerationPass> {
    const result: ModerationPass = {
      threads: 0,
      messages: 0,
      changed: [],
      learned: [],
    };
    const drafts = await this.watched();
    if (drafts.length === 0) return result;

    // Messages first: they say why.
    let messages: ModerationMessage[] = [];
    try {
      messages = await this.readMessages();
    } catch (error) {
      result.messagesSkipped =
        error instanceof Error ? error.message : String(error);
    }
    result.messages = messages.length;
    const explained = new Set<string>();
    for (const message of messages) {
      const draft = matchMessageToDraft(message, drafts);
      if (!draft) continue;
      explained.add(draft.id);
      // Already filed: nothing new.
      if (draft.moderationMessage === message.text.slice(0, 4000)) continue;
      const parsed = parseModerationMessage(message.text);
      await this.record(draft, {
        status: parsed.status,
        reason: parsed.reason,
        message: message.text,
        at: message.at,
        deadlineHours: parsed.deadlineHours,
      });
      result.changed.push({
        dealId: draft.dealId,
        status: parsed.status,
        reason: parsed.reason,
      });
      result.learned.push(...(await this.learn(draft, parsed.reason)));
    }

    // Then each thread as a visitor sees it.
    for (const draft of drafts.slice(0, MAX_THREADS_PER_PASS)) {
      const status = await this.threadStatus(draft.dealabsUrl!);
      result.threads++;
      await sleep(1_500);
      if (!status) continue;
      const known = draft.moderationStatus;
      if (status === "ok") {
        // Back online after a fix: the alert closes itself.
        if (known === "hidden") {
          await this.drafts.updateById(draft.id, {
            moderationStatus: "ok",
            moderationCheckedAt: this.dateTime.nowISOString(),
          });
          result.changed.push({ dealId: draft.dealId, status, reason: "" });
        } else {
          await this.drafts.updateById(draft.id, {
            moderationCheckedAt: this.dateTime.nowISOString(),
          });
        }
        continue;
      }
      if (explained.has(draft.id) || known === status || known === "deleted") {
        continue;
      }
      await this.record(draft, {
        status,
        reason: (draft.moderationReason as ModerationReason) ?? "other",
        message:
          draft.moderationMessage ??
          (status === "deleted"
            ? "Le post n'existe plus sur Dealabs (410)."
            : "Le post n'est plus visible pour un visiteur (masqué ou supprimé) ; aucun message des modérateurs lu."),
      });
      result.changed.push({
        dealId: draft.dealId,
        status,
        reason: draft.moderationReason ?? "other",
      });
    }
    if (result.changed.length) {
      this.log.info("Dealabs moderation changed", result);
    }
    return result;
  }

  protected async record(
    draft: Draft,
    outcome: {
      status: ModerationStatus;
      reason: ModerationReason;
      message: string;
      at?: string;
      deadlineHours?: number;
    },
  ): Promise<void> {
    const at = outcome.at ?? this.dateTime.nowISOString();
    const deadline = outcome.deadlineHours
      ? `\n[délai : ${outcome.deadlineHours} h]`
      : "";
    await this.drafts.updateById(draft.id, {
      moderationStatus: outcome.status,
      moderationReason: outcome.reason,
      moderationMessage: `${outcome.message.slice(0, 4000 - deadline.length)}${deadline}`,
      moderationAt: draft.moderationAt ?? at,
      moderationCheckedAt: this.dateTime.nowISOString(),
      // A new outcome reopens a closed alert.
      moderationDismissedAt: null,
    });
  }

  /** The checklist learns from a rejection (`config/moderation.json`). */
  protected async learn(
    draft: Draft,
    reason: ModerationReason,
  ): Promise<string[]> {
    const deal = await this.deals.findById(draft.dealId).catch(() => null);
    if (!deal) return [];
    try {
      const current = JSON.parse(this.agentFiles.readConfig("moderation"));
      const lesson = learnFromRejection(current, {
        reason,
        sourceId: deal.sourceId,
        sellerName: deal.sellerName,
        title: deal.title,
        at: this.dateTime.nowISOString(),
      });
      if (!lesson) return [];
      await this.agentFiles.writeConfig(
        "moderation",
        `${JSON.stringify(lesson.config, null, 2)}\n`,
        {
          agent: "moderation-inbox",
          reason: `Dealabs : ${MODERATION_REASON_LABELS[reason]} (${deal.title.slice(0, 80)})`,
          changelog: `## ${this.dateTime.nowISOString().slice(0, 10)} — moderation-inbox\n\n${lesson.changes.map((change) => `- ${change}`).join("\n")} (post « ${deal.title.slice(0, 80)} », ${MODERATION_REASON_LABELS[reason]})`,
        },
      );
      return lesson.changes;
    } catch (error) {
      this.log.warn("Moderation lesson not written", {
        dealId: draft.dealId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /** A thread's public page, read anonymously with plain fetch. */
  protected async threadStatus(
    url: string,
  ): Promise<ModerationStatus | undefined> {
    try {
      const response = await fetch(url, {
        headers: HEADERS,
        redirect: "follow",
        signal: AbortSignal.timeout(15_000),
      });
      return threadPublicStatus(response.status);
    } catch {
      return undefined;
    }
  }

  /**
   * The account's messages from Dealabs' team, read in the server's
   * headless browser with the saved session (`/profile/messages`). Local
   * server only, like publishing. Selectors are a best-effort read of
   * Dealabs' markup: any conversation whose preview or sender looks like
   * the moderators is opened and its text kept.
   */
  protected async readMessages(): Promise<ModerationMessage[]> {
    if (this.alepha.isServerless()) {
      throw new Error("pas de navigateur sur le déploiement serverless");
    }
    if (!existsSync(SESSION_PATH)) {
      throw new Error("pas de session Dealabs enregistrée");
    }
    return withBrowser(async (handle) => {
      if (handle.engine !== "playwright") return [];
      const context = await handle.browser.newContext({
        storageState: SESSION_PATH,
        locale: "fr-FR",
      });
      try {
        const page = await context.newPage();
        await page.goto("https://www.dealabs.com/profile/messages", {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await sleep(4_000);
        if (/\/login/.test(page.url())) {
          throw new Error("session Dealabs expirée");
        }
        const conversations = await page.evaluate(() =>
          Array.from(document.querySelectorAll("a[href]"))
            .map((link) => ({
              href: (link as HTMLAnchorElement).href,
              text: ((link as HTMLElement).innerText ?? "")
                .replace(/\s+/g, " ")
                .trim(),
            }))
            .filter(
              (link) =>
                /\/profile\/messages\/|\/conversation/.test(link.href) &&
                link.text.length > 0,
            )
            .slice(0, 30),
        );
        const messages: ModerationMessage[] = [];
        for (const conversation of conversations) {
          if (!isFromModerators({ text: conversation.text })) continue;
          if (messages.length >= 10) break;
          await page
            .goto(conversation.href, {
              waitUntil: "domcontentloaded",
              timeout: 45_000,
            })
            .catch(() => undefined);
          await sleep(2_500);
          const read = await page
            .evaluate(() => ({
              text: (
                document.querySelector("main")?.innerText ??
                document.body.innerText ??
                ""
              ).slice(0, 8000),
              links: Array.from(document.querySelectorAll("a[href]")).map(
                (link) => (link as HTMLAnchorElement).href,
              ),
              time:
                document
                  .querySelector("time[datetime]")
                  ?.getAttribute("datetime") ?? undefined,
            }))
            .catch(() => undefined);
          if (!read?.text) continue;
          messages.push({
            id: conversation.href,
            from: "L'équipe Dealabs",
            text: read.text,
            at: read.time,
            threadUrls: threadUrls(read.links.join(" ")),
          });
          await sleep(1_500);
        }
        return messages;
      } finally {
        await context.close();
      }
    });
  }

  /** Hidden or deleted posts Adam hasn't closed yet, newest first. */
  async alerts(): Promise<ModerationAlert[]> {
    const since =
      new Date(this.dateTime.nowISOString()).getTime() -
      ALERT_DAYS * 24 * 3600_000;
    return (await this.drafts.findMany({ where: { status: { eq: "posted" } } }))
      .filter(
        (draft) =>
          (draft.moderationStatus === "hidden" ||
            draft.moderationStatus === "deleted") &&
          !draft.moderationDismissedAt &&
          new Date(draft.moderationAt ?? draft.updatedAt).getTime() >= since,
      )
      .map((draft) => this.toAlert(draft))
      .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));
  }

  /** Every moderation outcome on our posts (debrief, weekly review). */
  async outcomes(days = 30): Promise<ModerationAlert[]> {
    const since =
      new Date(this.dateTime.nowISOString()).getTime() - days * 24 * 3600_000;
    return (await this.drafts.findMany({ where: { status: { eq: "posted" } } }))
      .filter(
        (draft) =>
          draft.moderationStatus &&
          draft.moderationStatus !== "ok" &&
          new Date(draft.moderationAt ?? draft.updatedAt).getTime() >= since,
      )
      .map((draft) => this.toAlert(draft));
  }

  toAlert(draft: Draft): ModerationAlert {
    const reason = (draft.moderationReason ?? "other") as ModerationReason;
    const hours = draft.moderationMessage?.match(/\[délai : (\d+) h\]$/)?.[1];
    return {
      dealId: draft.dealId,
      title: draft.title,
      dealabsUrl: draft.dealabsUrl ?? undefined,
      status: draft.moderationStatus as ModerationStatus,
      reason,
      label: MODERATION_REASON_LABELS[reason] ?? reason,
      message: draft.moderationMessage ?? undefined,
      at: draft.moderationAt ?? undefined,
      deadline:
        hours && draft.moderationAt
          ? new Date(
              new Date(draft.moderationAt).getTime() + Number(hours) * 3600_000,
            ).toISOString()
          : undefined,
    };
  }

  /**
   * Hidden/deleted rate of our posts over `days` (weekly review, target
   * < 5 %), by source, category and reason. Baseline before epic 29:
   * 6 of ~40 posts (26/10–04/11).
   */
  async stats(days = 7): Promise<ModerationStats> {
    const since =
      new Date(this.dateTime.nowISOString()).getTime() - days * 24 * 3600_000;
    const posted = (
      await this.drafts.findMany({ where: { status: { eq: "posted" } } })
    ).filter(
      (draft) =>
        new Date(
          draft.verifiedAt ?? draft.lastPublishAttemptAt ?? draft.updatedAt,
        ).getTime() >= since,
    );
    const deals = posted.length
      ? await this.deals.findMany({
          where: { id: { inArray: posted.map((draft) => draft.dealId) } },
        })
      : [];
    const dealOf = new Map(deals.map((deal) => [deal.id, deal]));
    const stats: ModerationStats = {
      days,
      posts: posted.length,
      rejected: 0,
      rate: 0,
      bySource: {},
      byCategory: {},
      byReason: {},
    };
    for (const draft of posted) {
      const deal = dealOf.get(draft.dealId);
      const rejected =
        draft.moderationStatus === "hidden" ||
        draft.moderationStatus === "deleted";
      const bump = (
        map: Record<string, { posts: number; rejected: number }>,
        key: string,
      ) => {
        map[key] ??= { posts: 0, rejected: 0 };
        map[key].posts++;
        if (rejected) map[key].rejected++;
      };
      bump(stats.bySource, deal?.sourceId ?? "?");
      bump(stats.byCategory, deal?.categoryId ?? "?");
      if (rejected) {
        stats.rejected++;
        const reason = draft.moderationReason ?? "other";
        stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
      }
    }
    stats.rate = stats.posts
      ? Math.round((stats.rejected / stats.posts) * 1000) / 10
      : 0;
    return stats;
  }

  /** « Vu » on the banner: the alert closes, the outcome stays. */
  async dismiss(dealId: string): Promise<void> {
    const draft = await this.drafts.findOne({
      where: { dealId: { eq: dealId } },
    });
    if (!draft) return;
    await this.drafts.updateById(draft.id, {
      moderationDismissedAt: this.dateTime.nowISOString(),
    });
  }
}
