import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { $inject } from "alepha";
import { DateTimeProvider } from "alepha/datetime";
import { $logger } from "alepha/logger";
import { $repository } from "alepha/orm";
import { HttpError } from "alepha/server";

import { agentWriteEntity } from "../entities/AgentWrite.ts";
import {
  AGENT_CONFIGS,
  AGENT_DATA_FILE,
  AGENT_DATA_MAX_BYTES,
  AGENT_REPORT_ID,
  type AgentConfigName,
  checkAgentConfig,
} from "./agentConfig.ts";
import { appDir } from "./appDir.ts";

/** Write through a temp file + rename: a reader never sees half a file. */
export function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/** Adds an entry right under a changelog's header (they are newest first). */
export function insertChangelogEntry(current: string, entry: string): string {
  const block = `${entry.trim()}\n\n`;
  const at = current.search(/^## /m);
  if (at < 0) return `${current.trimEnd()}\n\n${block}`;
  return `${current.slice(0, at)}${block}${current.slice(at)}`;
}

export interface AgentWriteInput {
  agent: string;
  reason?: string;
}

/**
 * The files the agents read and write (`config/*`, `data/agents/*`,
 * `docs/*-changelog.md`), kept under `appDir()` — the folder that survives
 * a deploy on Bay. Every write is checked (bounds, allowed names), atomic,
 * and recorded in `agent_writes`; a config write also keeps the previous
 * version next to it (`<name>.previous.json`) for a one-step rollback.
 */
export class AgentFilesService {
  protected log = $logger();
  protected dateTime = $inject(DateTimeProvider);
  protected writes = $repository(agentWriteEntity);

  protected configPath(name: AgentConfigName): string {
    return join(appDir(), "config", AGENT_CONFIGS[name].file);
  }

  /** Current content; falls back to the copy shipped with the code. */
  readConfig(name: AgentConfigName): string {
    const file = this.configPath(name);
    if (existsSync(file)) return readFileSync(file, "utf8");
    const shipped = join(process.cwd(), "config", AGENT_CONFIGS[name].file);
    if (existsSync(shipped)) return readFileSync(shipped, "utf8");
    throw new HttpError({ status: 404, message: `${name} introuvable` });
  }

  async writeConfig(
    name: AgentConfigName,
    content: string,
    input: AgentWriteInput & { changelog?: string },
  ): Promise<{ changes: string[] }> {
    const previous = this.readConfig(name);
    const { errors, changes } = checkAgentConfig(name, previous, content);
    if (errors.length > 0) {
      throw new HttpError({
        status: 422,
        message: `Refusé : ${errors.join(" ; ")}`,
      });
    }
    if (previous === content) return { changes: [] };

    const file = this.configPath(name);
    const ext = name === "selection-lessons" ? ".md" : ".json";
    writeAtomic(file.replace(/\.(json|md)$/, `.previous${ext}`), previous);
    writeAtomic(file, content.endsWith("\n") ? content : `${content}\n`);

    const changelog = AGENT_CONFIGS[name].changelog;
    if (changelog && input.changelog?.trim()) {
      const docFile = join(appDir(), "docs", `${changelog}-changelog.md`);
      const current = existsSync(docFile)
        ? readFileSync(docFile, "utf8")
        : `# ${changelog} — changelog\n\n`;
      writeAtomic(docFile, insertChangelogEntry(current, input.changelog));
    }

    await this.audit({
      ...input,
      kind: "config",
      target: name,
      summary: changes.join("\n"),
      before: previous,
      after: content,
    });
    this.log.info(`agent ${input.agent} updated ${name}`, { changes });
    return { changes };
  }

  /** `data/agents/reports/<id>.md`, shown on the console's Agents page. */
  async writeReport(id: string, markdown: string, input: AgentWriteInput) {
    this.assertMarkdown(id, markdown);
    writeAtomic(
      join(appDir(), "data", "agents", "reports", `${id}.md`),
      markdown,
    );
    await this.audit({ ...input, kind: "report", target: `reports/${id}` });
  }

  /** `data/agents/code-proposal-<slug>.md`, picked up by `deals-code`. */
  async writeProposal(slug: string, markdown: string, input: AgentWriteInput) {
    this.assertMarkdown(slug, markdown);
    writeAtomic(
      join(appDir(), "data", "agents", `code-proposal-${slug}.md`),
      markdown,
    );
    await this.audit({
      ...input,
      kind: "proposal",
      target: `code-proposal-${slug}`,
      after: markdown,
    });
  }

  /** A daily output of `dealradar.mjs` (`report-YYYY-MM-DD.json`…). */
  async writeData(name: string, content: string, input: AgentWriteInput) {
    this.assertDataName(name);
    if (Buffer.byteLength(content, "utf8") > AGENT_DATA_MAX_BYTES) {
      throw new HttpError({ status: 413, message: "fichier trop gros" });
    }
    try {
      JSON.parse(content);
    } catch {
      throw new HttpError({ status: 422, message: "JSON invalide" });
    }
    writeAtomic(join(appDir(), "data", "agents", name), content);
    await this.audit({ ...input, kind: "data", target: name });
  }

  readData(name: string): string | undefined {
    if (name !== "ledger.jsonl") this.assertDataName(name);
    const file = join(appDir(), "data", "agents", name);
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  }

  /** Configs, proposals and schedules written since `since` (agent health). */
  async decisionsSince(since: Date) {
    const rows = await this.writes.findMany({
      where: {
        createdAt: { gte: since.toISOString() },
        kind: { inArray: ["config", "proposal", "schedule"] },
      },
      orderBy: { column: "createdAt", direction: "desc" },
      limit: 500,
    });
    return rows.map(({ agent, kind, target, createdAt }) => ({
      agent,
      kind,
      target,
      createdAt: String(createdAt),
    }));
  }

  async changes(limit = 50) {
    const rows = await this.writes.findMany({
      orderBy: { column: "createdAt", direction: "desc" },
      limit: Math.min(Math.max(limit, 1), 200),
    });
    return rows.map(({ before: _b, after: _a, ...row }) => row);
  }

  async audit(row: {
    agent: string;
    kind: "config" | "report" | "proposal" | "data" | "schedule";
    target: string;
    reason?: string;
    summary?: string;
    before?: string;
    after?: string;
  }) {
    await this.writes.create({
      ...row,
      agent: row.agent.slice(0, 80) || "agent",
      reason: row.reason?.slice(0, 4000),
    });
  }

  protected assertMarkdown(id: string, markdown: string) {
    if (!AGENT_REPORT_ID.test(id)) {
      throw new HttpError({ status: 400, message: "identifiant invalide" });
    }
    if (Buffer.byteLength(markdown, "utf8") > AGENT_DATA_MAX_BYTES) {
      throw new HttpError({ status: 413, message: "texte trop long" });
    }
  }

  protected assertDataName(name: string) {
    if (!AGENT_DATA_FILE.test(name)) {
      throw new HttpError({ status: 400, message: "nom de fichier refusé" });
    }
  }
}
