import { $inject, Alepha, z } from "alepha";
import { $action, HttpError } from "alepha/server";

import { $agentAuth } from "../services/AdminAuth.ts";
import { isAgentConfigName } from "../services/agentConfig.ts";
import { AgentFilesService } from "../services/AgentFilesService.ts";

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
}
