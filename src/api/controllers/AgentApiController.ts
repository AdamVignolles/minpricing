import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { $inject, Alepha, z } from "alepha";
import { $repository } from "alepha/orm";
import { $action, HttpError } from "alepha/server";

import { dealEntity } from "../entities/Deal.ts";
import { sourceEntity } from "../entities/Source.ts";
import { $agentAuth } from "../services/AdminAuth.ts";
import { isAgentConfigName } from "../services/agentConfig.ts";
import { AgentFilesService } from "../services/AgentFilesService.ts";
import { appDir } from "../services/appDir.ts";
import {
  DealabsCommentsService,
  isDealabsThreadUrl,
} from "../services/DealabsCommentsService.ts";

const rich = () => z.text({ size: "rich" });
/** File contents: up to the 2 MB cap enforced by `AgentFilesService`. */
const big = () => z.text({ maxLength: 2_000_000 });
const who = {
  /** The skill or routine writing (`deals-weekly`…), for the audit trail. */
  agent: z.text({ minLength: 1, maxLength: 80 }),
  reason: rich().optional(),
};

/**
 * The agents' write API (`/agent/*`), for the scheduled Claude routines
 * and `dealradar.mjs` in remote mode: the files they tune, checked against
 * their own bounds (`agentConfig.ts`), their reports and code proposals,
 * and their daily outputs. Guarded by the agent token (`AGENT_TOKEN`) or
 * the admin session; every accepted write is in `agent_writes`
 * (`GET /agent/changes`). Nothing here publishes, collects or touches a
 * deal — tonight's publishing plan has its own endpoints
 * (`PublishScheduleController`).
 */
export class AgentApiController {
  protected alepha = $inject(Alepha);
  protected files = $inject(AgentFilesService);
  protected comments = $inject(DealabsCommentsService);
  protected deals = $repository(dealEntity);
  protected sources = $repository(sourceEntity);

  protected caller(agent: string): string {
    const request = this.alepha.store.get("alepha.http.request");
    return request?.metadata?.agentCaller === "admin"
      ? `admin (${agent})`
      : agent;
  }

  protected configName(name: string) {
    if (!isAgentConfigName(name)) {
      throw new HttpError({ status: 404, message: "fichier inconnu" });
    }
    return name;
  }

  agentConfigGet = $action({
    method: "GET",
    path: "/agent/config/:name",
    use: [$agentAuth()],
    schema: {
      params: z.object({ name: z.text() }),
      response: z.object({ name: z.text(), content: big() }),
    },
    handler: ({ params }) => {
      const name = this.configName(params.name);
      return { name, content: this.files.readConfig(name) };
    },
  });

  agentConfigPut = $action({
    method: "PUT",
    path: "/agent/config/:name",
    use: [$agentAuth()],
    schema: {
      params: z.object({ name: z.text() }),
      body: z.object({
        content: big(),
        /** A changelog entry (`## vN — date — agent` + bullets). */
        changelog: rich().optional(),
        ...who,
      }),
      response: z.object({ ok: z.boolean(), changes: z.array(rich()) }),
    },
    handler: async ({ params, body }) => {
      const name = this.configName(params.name);
      const { changes } = await this.files.writeConfig(name, body.content, {
        agent: this.caller(body.agent),
        reason: body.reason,
        changelog: body.changelog,
      });
      return { ok: true, changes };
    },
  });

  agentReportPut = $action({
    method: "PUT",
    path: "/agent/reports/:id",
    use: [$agentAuth()],
    schema: {
      params: z.object({ id: z.text() }),
      body: z.object({ markdown: big(), ...who }),
      response: z.object({ ok: z.boolean() }),
    },
    handler: async ({ params, body }) => {
      await this.files.writeReport(params.id, body.markdown, {
        agent: this.caller(body.agent),
        reason: body.reason,
      });
      return { ok: true };
    },
  });

  agentProposalPut = $action({
    method: "PUT",
    path: "/agent/proposals/:slug",
    use: [$agentAuth()],
    schema: {
      params: z.object({ slug: z.text() }),
      body: z.object({ markdown: big(), ...who }),
      response: z.object({ ok: z.boolean() }),
    },
    handler: async ({ params, body }) => {
      await this.files.writeProposal(params.slug, body.markdown, {
        agent: this.caller(body.agent),
        reason: body.reason,
      });
      return { ok: true };
    },
  });

  agentDataGet = $action({
    method: "GET",
    path: "/agent/data/:file",
    use: [$agentAuth()],
    schema: {
      params: z.object({ file: z.text() }),
      response: z.object({ file: z.text(), content: big().optional() }),
    },
    handler: ({ params }) => ({
      file: params.file,
      content: this.files.readData(params.file),
    }),
  });

  agentDataPut = $action({
    method: "PUT",
    path: "/agent/data/:file",
    use: [$agentAuth()],
    schema: {
      params: z.object({ file: z.text() }),
      body: z.object({ content: big(), ...who }),
      response: z.object({ ok: z.boolean() }),
    },
    handler: async ({ params, body }) => {
      await this.files.writeData(params.file, body.content, {
        agent: this.caller(body.agent),
        reason: body.reason,
      });
      return { ok: true };
    },
  });

  agentChanges = $action({
    method: "GET",
    path: "/agent/changes",
    use: [$agentAuth()],
    schema: {
      query: z.object({ limit: z.number().optional() }),
      response: z.array(
        z.object({
          id: z.text(),
          agent: z.text(),
          kind: z.text(),
          target: z.text(),
          reason: rich().optional(),
          summary: rich().optional(),
          createdAt: z.text(),
        }),
      ),
    },
    handler: async ({ query }) =>
      (await this.files.changes(query.limit)).map((row) => ({
        ...row,
        createdAt: String(row.createdAt),
      })),
  });

  /**
   * The read-only rows `dealradar.mjs` `tune-stats` and `sources-review`
   * query (same column names as the database), plus the collection run
   * log: in remote mode the script loads them into an in-memory SQLite and
   * runs its usual queries, so the cloud routines get the same figures.
   * Deals seen within `days`, plus any with a stored Dealabs history
   * (threads trimmed to url/title/temperature/mine).
   */
  agentDataset = $action({
    method: "GET",
    path: "/agent/dataset",
    use: [$agentAuth()],
    schema: {
      query: z.object({ days: z.number().optional() }),
      response: z.object({
        deals: z.array(z.any()),
        sources: z.array(z.any()),
        collectionRuns: big(),
      }),
    },
    handler: async ({ query }) => {
      const days = Math.min(Math.max(query.days ?? 30, 1), 120);
      const since = Date.now() - days * 86_400_000;
      const trimHistory = (raw?: string) => {
        if (!raw || raw === "[]") return undefined;
        try {
          const list = JSON.parse(raw) as Array<Record<string, unknown>>;
          return JSON.stringify(
            list.map((t) => ({
              url: t.url,
              title: t.title,
              temperature: t.temperature,
              mine: t.mine,
            })),
          );
        } catch {
          return undefined;
        }
      };
      const deals = (await this.deals.findMany({}))
        .map((d) => ({
          source_id: d.sourceId,
          category_id: d.categoryId ?? null,
          status: d.status,
          score: d.score ?? null,
          hot_chance: d.hotChance ?? null,
          last_seen_at: new Date(d.lastSeenAt).getTime(),
          dealabs_history: trimHistory(d.dealabsHistory) ?? null,
        }))
        .filter((d) => d.last_seen_at >= since || d.dealabs_history);
      const sources = (await this.sources.findMany({})).map((s) => ({
        id: s.id,
        enabled: s.enabled ? 1 : 0,
        last_error: s.lastError ?? null,
      }));
      const runsFile = join(
        appDir(),
        "data",
        "agents",
        "collection-runs.jsonl",
      );
      const collectionRuns = existsSync(runsFile)
        ? readFileSync(runsFile, "utf8")
            .split(/\r?\n/)
            .filter((line) => {
              const at = line.match(/"at":"([^"]+)"/)?.[1];
              return at !== undefined && new Date(at).getTime() >= since;
            })
            .join("\n")
            .slice(-1_900_000)
        : "";
      return { deals, sources, collectionRuns };
    },
  });

  /**
   * The first comments of our Dealabs threads, read in the VM's browser:
   * `profile-review` in a cloud routine (no Playwright there). Dealabs
   * thread URLs only, 6 at most per call (~10 s each).
   */
  agentDealabsComments = $action({
    method: "POST",
    path: "/agent/dealabs-comments",
    use: [$agentAuth()],
    schema: {
      body: z.object({ urls: z.array(z.text({ maxLength: 500 })) }),
      response: z.object({ comments: z.record(z.text(), z.array(z.text())) }),
    },
    handler: async ({ body }) => {
      const urls = [...new Set(body.urls)];
      if (urls.length > 6 || !urls.every(isDealabsThreadUrl)) {
        throw new HttpError({
          status: 400,
          message: "6 URLs de fils Dealabs au plus",
        });
      }
      if (this.alepha.isServerless()) {
        throw new HttpError({ status: 503, message: "pas de navigateur ici" });
      }
      return { comments: await this.comments.read(urls) };
    },
  });
}
