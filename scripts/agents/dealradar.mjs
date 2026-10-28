#!/usr/bin/env node
/**
 * Local bridge between the Claude agents and the running DealRadar server.
 * Everything deterministic happens here, at zero token cost: filtering and
 * ranking by the rules, the random daily plan, publishing, statistics, and
 * the exact Notion rows to write. Claude only reads the small JSON printed.
 *
 *   ensure-server               start `npm run dev` if the API doesn't answer
 *   report [hours] [days]       save today's report (candidates + our posts)
 *   shortlist                   eligible deals ranked by the rules (for deals-select)
 *   publish-queue <queue.json>  random plan (count + times), then publish
 *   notion-log <plan|final>     the Notion rows/journal to write (for deals-log)
 *   stats [days]                aggregates for the weekly review (deals-weekly)
 *   posted                      one line per published deal with its result
 *   check-shop <dealId>         the app's pre-publish page check, dry run
 *   publish <dealId>            publish one deal now
 *   ledger [days]               what the agents published, as predicted
 *   sources-review [days]       yield/time per source + what goes hot on Dealabs (deals-sources)
 *   probe <url>                 can a candidate shop be read with plain fetch?
 *   push-config <name> [agent] [reason] [changelog.md]
 *                               remote mode: send a tuned config/<name> to the VM
 *   push-proposal <file.md> [agent]
 *                               remote mode: send a code proposal to the VM
 *
 * Remote mode (`DEALRADAR_URL` + `DEALRADAR_TOKEN`, from the environment or
 * .env): the same commands against the online app (Bay VM) instead of a
 * local server — for the Claude cloud routines. Before a command, the
 * configs, the ledger and today's files are pulled from the VM into this
 * checkout; after it, today's files and reports it wrote are pushed back
 * (`/api/agent/*`, see AgentApiController). Reads use the agent token on
 * the console's GET endpoints; nothing can publish directly: publish-queue
 * hands tonight's plan to the app's own schedule (`/api/agent/schedule`).
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const outDir = join(root, "data", "agents");
mkdirSync(outDir, { recursive: true });
const ledgerFile = join(outDir, "ledger.jsonl");
const PANEL_DUPLICATE = "Dealabs signale que ce deal existe déjà";
/** Attempts per planned time: the deal in line plus the next ones. */
const MAX_TRIES_PER_SLOT = 4;

function readEnv() {
  const env = {};
  const file = join(root, ".env");
  if (!existsSync(file)) return env;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

const env = readEnv();
const remote = (process.env.DEALRADAR_URL ?? env.DEALRADAR_URL ?? "").replace(
  /\/+$/,
  "",
);
const agentToken = process.env.DEALRADAR_TOKEN ?? env.DEALRADAR_TOKEN ?? "";
// The plan, the ledger and the file names are in Paris days, wherever the
// routine runs.
if (remote && !process.env.TZ) process.env.TZ = "Europe/Paris";
/** Daily files the VM accepts (AGENT_DATA_FILE in agentConfig.ts). */
const DATA_KINDS = [
  "report",
  "shortlist",
  "queue",
  "plan",
  "published",
  "stats",
  "tune-stats",
  "profile-review",
  "sources-review",
];
const CONFIG_FILES = {
  "publish-rules": "publish-rules.json",
  desirability: "desirability.json",
  collection: "collection.json",
  "selection-lessons": "selection-lessons.md",
};
const credentials = {
  username: env.ADMIN_USERNAME ?? "admin",
  password: env.ADMIN_PASSWORD ?? "admin",
};
const ports = [
  ...new Set([env.SERVER_PORT, env.PORT, "3000", "5173"].filter(Boolean)),
];
const today = () => new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD, local
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const hhmm = (date) => date.toTimeString().slice(0, 5);
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const rules = () => readJson(join(root, "config", "publish-rules.json"));
const fileOf = (kind, date = today()) => join(outDir, `${kind}-${date}.json`);

let session; // { base, cookie }

async function login() {
  if (session) return session;
  if (remote) {
    if (!agentToken) throw new Error("DEALRADAR_TOKEN is not set");
    const base = `${remote}/api`;
    const res = await fetch(`${base}/agent/changes?limit=1`, {
      headers: { authorization: `Bearer ${agentToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(
        `DealRadar at ${remote} refused the token (${res.status})`,
      );
    }
    session = { base, auth: `Bearer ${agentToken}` };
    return session;
  }
  for (const port of ports) {
    const base = `http://localhost:${port}/api`;
    try {
      const res = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(credentials),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const cookie = (
        res.headers.getSetCookie?.() ?? [res.headers.get("set-cookie")]
      )
        .filter(Boolean)
        .map((value) => value.split(";")[0])
        .join("; ");
      session = { base, cookie };
      return session;
    } catch {
      // Not this port.
    }
  }
  throw new Error(
    `DealRadar server not reachable on ports ${ports.join(", ")}`,
  );
}

async function api(method, path, body) {
  const { base, cookie, auth } = await login();
  const init = {
    method,
    headers: {
      ...(auth ? { authorization: auth } : { cookie }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    signal: AbortSignal.timeout(10 * 60_000),
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function ensureServer() {
  if (remote)
    return { running: true, base: (await login()).base, remote: true };
  try {
    return { running: true, base: (await login()).base, started: false };
  } catch {
    // Start it below.
  }
  const log = openSync(join(outDir, "server.log"), "a");
  const child = spawn("npm run dev", {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    shell: true,
    windowsHide: true,
  });
  child.unref();
  for (let waited = 0; waited < 240; waited += 5) {
    await sleep(5000);
    try {
      return { running: true, base: (await login()).base, started: true };
    } catch {
      // Still booting.
    }
  }
  return {
    running: false,
    started: true,
    error: "server did not answer within 4 min — see data/agents/server.log",
  };
}

function readLedger(days = 60) {
  if (!existsSync(ledgerFile)) return [];
  const since = Date.now() - days * 86_400_000;
  return readFileSync(ledgerFile, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => new Date(entry.at).getTime() >= since);
}

async function fetchReport(hours, days) {
  // Best 15 of each category (not an overall top-N, which is all games).
  const res = await api(
    "GET",
    `/admin/agent-report?hours=${hours}&days=${days}&perCategory=15&limit=200`,
  );
  if (!res.ok) {
    throw new Error(
      `report failed (${res.status}): ${JSON.stringify(res.body).slice(0, 300)}`,
    );
  }
  const report = { ...res.body, ledger: readLedger(Math.max(Number(days), 1)) };
  writeFileSync(fileOf("report"), JSON.stringify(report));
  return report;
}

/** Deals already tried today, except one stopped once by Dealabs' panel. */
function triedToday() {
  const todays = readLedger(1).filter((e) => e.date === today());
  const panelOnly = (e) =>
    e.result === "duplicate" && e.error?.startsWith(PANEL_DUPLICATE);
  return new Set(
    todays
      .filter(
        (e) =>
          (!panelOnly(e) && e.result !== "unavailable") ||
          todays.filter((o) => o.dealId === e.dealId).length > 1,
      )
      .map((e) => e.dealId),
  );
}

const band = (price) =>
  price < 30
    ? "<30"
    : price < 100
      ? "30-100"
      : price < 300
        ? "100-300"
        : ">300";

function isPublishDay(r, date = new Date()) {
  // publishDays: 1 = Monday … 7 = Sunday.
  const weekday = date.getDay() === 0 ? 7 : date.getDay();
  return r.publishDays.includes(weekday);
}

async function shortlist() {
  const r = rules();
  const report = await fetchReport(24, 0);
  const tried = triedToday();
  // Why the other candidates were left out — shown in the evening report.
  const rejected = {
    sourceExclue: 0,
    dejaTenteAujourdhui: 0,
    scoreTropBas: 0,
    chanceHotTropBasse: 0,
  };
  const scored = report.candidates
    .filter((c) => {
      if (r.excludedSources.includes(c.sourceId))
        return (rejected.sourceExclue++, false);
      if (tried.has(c.id)) return (rejected.dejaTenteAujourdhui++, false);
      return true;
    })
    .map((c) => {
      const adjusted =
        (c.hotChance ?? 0) +
        (r.categoryAdjust[c.categoryId] ?? 0) +
        (r.sourceAdjust[c.sourceId] ?? 0) +
        (r.priceBandAdjust[band(c.price)] ?? 0);
      return { ...c, adjusted };
    })
    .filter((c) => {
      if (c.score < r.minScore) return (rejected.scoreTropBas++, false);
      if (c.adjusted < r.minHotChance)
        return (rejected.chanceHotTropBasse++, false);
      return true;
    });
  // Diversity: at most `shortlistPerCategory` of one category in the list,
  // so backups aren't all the same kind of deal.
  const perCategory = {};
  const ranked = scored
    .sort((a, b) => b.adjusted - a.adjusted || b.score - a.score)
    .filter((c) => {
      perCategory[c.categoryId] = (perCategory[c.categoryId] ?? 0) + 1;
      return perCategory[c.categoryId] <= (r.shortlistPerCategory ?? 99);
    })
    .slice(0, 12)
    .map((c) => ({
      id: c.id,
      title: c.title.slice(0, 90),
      src: c.sourceId,
      cat: c.categoryId,
      price: c.price,
      ref: c.referencePrice,
      disc: c.discount,
      score: c.score,
      hot: c.hotChance,
      adj: c.adjusted,
      rating: c.rating,
      reviews: c.reviews,
      seller: c.seller,
      sold: c.soldByMerchant,
      dlBest: c.dealabsBestTemperature,
      dlLow: c.dealabsLowestPrice,
    }));
  const result = {
    date: today(),
    rulesVersion: r.version,
    publishToday: isPublishDay(r),
    perDay: r.perDay,
    candidates: report.candidates.length,
    eligible: scored.length,
    rejected,
    rules: {
      minScore: r.minScore,
      minHotChance: r.minHotChance,
      excludedSources: r.excludedSources,
    },
    ranked,
  };
  writeFileSync(fileOf("shortlist"), JSON.stringify(result));
  return result;
}

/** N random times in [from, to], at least `gap` minutes apart, sorted. */
function randomTimes(count, from, to, gapMinutes) {
  const gap = gapMinutes * 60_000;
  const span = to.getTime() - from.getTime();
  if (span < 0) return [];
  const n = Math.min(count, Math.floor(span / gap) + 1);
  const free = span - (n - 1) * gap;
  return Array.from({ length: n }, () => Math.random() * free)
    .sort((a, b) => a - b)
    .map((offset, i) => new Date(from.getTime() + offset + i * gap));
}

function atToday(hm) {
  const [h, m] = hm.split(":").map(Number);
  const date = new Date();
  date.setHours(h, m, 0, 0);
  return date;
}

async function publish(dealId) {
  if (remote) {
    return {
      result: "failed",
      error:
        "remote mode: agents don't publish directly — publish-queue hands the plan to the app",
    };
  }
  // The app checks the merchant page itself before posting (site up,
  // product there, price unchanged) and answers 422 when it isn't.
  const res = await api(
    "POST",
    `/deals/${encodeURIComponent(dealId)}/draft/auto-publish`,
  );
  const result = res.ok
    ? "success"
    : res.status === 409
      ? "duplicate"
      : res.status === 422
        ? "unavailable"
        : "failed";
  return {
    result,
    status: res.status,
    url: res.ok ? res.body?.dealabsUrl : undefined,
    error: res.ok
      ? undefined
      : String(res.body?.message ?? res.body).slice(0, 300),
  };
}

async function publishQueue(file, now = false) {
  const r = rules();
  const queue = readJson(resolve(file));
  // Old queues had items + backups; new ones a single ranked list.
  const ranked = queue.ranked ?? [
    ...(queue.items ?? []),
    ...(queue.backups ?? []),
  ];
  if (remote) {
    // The app draws the times and publishes at each one itself.
    const res = await api("PUT", "/agent/schedule", {
      ranked,
      agent: process.env.DEALRADAR_AGENT ?? "deals-select",
      reason: queue.reason ?? queue.summary,
      ...(now ? { now: true } : {}),
    });
    if (!res.ok) {
      throw new Error(
        `schedule refused (${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`,
      );
    }
    return res.body;
  }
  const planFile = fileOf("plan");
  if (!isPublishDay(r)) {
    const plan = {
      date: today(),
      skipped: "pas de publication ce jour (week-end)",
      times: [],
    };
    writeFileSync(planFile, JSON.stringify(plan));
    return plan;
  }

  const doneToday = () =>
    readLedger(1).filter((e) => e.date === today() && e.result === "success");
  // `--now` (manual test): keep today's drawn count, publish right away,
  // one minute apart, instead of waiting for the drawn times.
  const earlier = existsSync(planFile) ? readJson(planFile) : undefined;
  const target =
    now && earlier?.date === today() && earlier.target !== undefined
      ? Math.max(0, earlier.target - doneToday().length)
      : Math.max(
          0,
          r.perDay.min +
            Math.floor(Math.random() * (r.perDay.max - r.perDay.min + 1)) -
            doneToday().length,
        );
  const count = Math.min(target, ranked.length);
  const times = now
    ? Array.from({ length: count }, (_, i) => new Date(Date.now() + i * 60_000))
    : randomTimes(
        count,
        new Date(
          Math.max(atToday(r.window.start).getTime(), Date.now() + 5 * 60_000),
        ),
        atToday(r.window.end),
        r.minGapMinutes,
      );
  const plan = {
    date: today(),
    target,
    times: times.map(hhmm),
    planned: ranked.slice(0, times.length).map((d) => d.dealId),
  };
  writeFileSync(planFile, JSON.stringify(plan));

  const tried = triedToday();
  const results = [];
  for (const time of times) {
    if (doneToday().length >= r.perDay.max) break;
    const delay = time.getTime() - Date.now();
    if (delay > 0) await sleep(delay);
    let attempts = 0;
    for (const candidate of ranked) {
      if (attempts >= MAX_TRIES_PER_SLOT) break;
      if (tried.has(candidate.dealId)) continue;
      const sameCategory = doneToday().filter(
        (e) => e.categoryId === candidate.categoryId,
      ).length;
      const cap =
        r.categoryCaps?.[candidate.categoryId] ?? r.maxPerCategoryPerDay;
      if (candidate.categoryId && sameCategory >= cap) continue;
      attempts++;
      tried.add(candidate.dealId);
      const outcome = await publish(candidate.dealId).catch((error) => ({
        result: "failed",
        error: String(error).slice(0, 300),
      }));
      const entry = {
        date: today(),
        at: new Date().toISOString(),
        slot: hhmm(time),
        ...candidate,
        ...outcome,
      };
      appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
      results.push(entry);
      if (outcome.result === "success") break;
    }
  }
  writeFileSync(
    fileOf("published"),
    JSON.stringify({ date: today(), plan, results }, null, 2),
  );
  return { plan, results };
}

/** Local copy of a report, shown by the console's Agents page. */
function writeReport(name, markdown) {
  const dir = join(outDir, "reports");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), markdown);
}
function appendReport(name, marker, markdown) {
  const file = join(outDir, "reports", `${name}.md`);
  if (!existsSync(file)) return;
  const current = readFileSync(file, "utf8");
  if (!current.includes(marker))
    writeFileSync(
      file,
      `${current}
${markdown}
`,
    );
}

const STATUS = {
  success: "✅ Publié",
  failed: "❌ Échec",
  duplicate: "♻️ Doublon",
  unavailable: "⏭️ Ignoré",
  skipped: "⏭️ Ignoré",
};

/**
 * Exactly what the deals-log skill must write to Notion, so the (cheap)
 * model only copies values. `plan`: tonight's planned deals; `final`:
 * outcomes + fresh temperatures of the last 14 days' posts.
 */
async function notionLog(mode) {
  const date = today();
  const queue = existsSync(fileOf("queue"))
    ? readJson(fileOf("queue"))
    : { ranked: [] };
  const ranked = queue.ranked ?? [
    ...(queue.items ?? []),
    ...(queue.backups ?? []),
  ];
  const plan = existsSync(fileOf("plan"))
    ? readJson(fileOf("plan"))
    : undefined;
  const shortlistFile = existsSync(fileOf("shortlist"))
    ? readJson(fileOf("shortlist"))
    : undefined;

  const cell = (value) =>
    String(value ?? "—")
      .replace(/\|/g, "/")
      .replace(/\n/g, " ");
  const euro = (value) =>
    value === undefined
      ? "—"
      : value === 0
        ? "gratuit"
        : `${String(value).replace(".", ",")} €`;

  if (mode === "plan") {
    const sl = shortlistFile ?? {
      candidates: 0,
      eligible: 0,
      rejected: {},
      rules: {},
    };
    const rej = sl.rejected ?? {};
    const vetoed = queue.vetoed ?? [];
    const times = plan?.times ?? [];
    const role = (dealId) => {
      const i = plan?.planned?.indexOf(dealId) ?? -1;
      return i >= 0 ? `🕒 prévu à ${times[i]}` : "remplaçant";
    };
    const journalBody = [
      `<callout icon="🎯" color="blue_bg">`,
      plan?.skipped
        ? `Pas de publication aujourd'hui : ${plan.skipped}.`
        : `<b>${times.length} publication(s) tirée(s) au sort</b> à ${times.join(", ") || "—"} parmi <b>${ranked.length}</b> deals retenus (sur ${sl.candidates} candidats vus en 24 h). Si un deal échoue (page refusée, doublon), le suivant de la liste prend sa place.`,
      `</callout>`,
      "",
      "## Entonnoir de sélection",
      "",
      "| Étape | Deals |",
      "| --- | --- |",
      `| Candidats vus en 24 h (pas encore tentés, pas déjà sur Dealabs) | ${sl.candidates} |`,
      ...(sl.rejected
        ? [
            `| ❌ Source exclue (${(sl.rules?.excludedSources ?? []).join(", ")}) | ${rej.sourceExclue ?? 0} |`,
            `| ❌ Déjà tenté aujourd'hui | ${rej.dejaTenteAujourdhui ?? 0} |`,
            `| ❌ Score sous ${sl.rules?.minScore} | ${rej.scoreTropBas ?? 0} |`,
            `| ❌ Chance hot sous ${sl.rules?.minHotChance} % | ${rej.chanceHotTropBasse ?? 0} |`,
          ]
        : [
            `| ❌ Écartés par les règles (source, score, chance hot) | ${sl.candidates - sl.eligible} |`,
          ]),
      `| ✅ Éligibles selon les règles (v${sl.rulesVersion ?? "?"}) | ${sl.eligible} |`,
      `| 🚫 Écartés par l'agent (jugement) | ${vetoed.length} |`,
      `| 🎯 Retenus, dans l'ordre de passage | ${ranked.length} |`,
      "",
      "## Deals retenus",
      "",
      "| # | Deal | Source | Prix | Score | Chance hot | Rôle | Pourquoi |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      ...ranked.map(
        (d, i) =>
          `| ${i + 1} | ${cell(d.title?.slice(0, 70))} | ${cell(d.sourceId)} | ${euro(d.price)} | ${cell(d.score)} | ${cell(d.adjustedHotChance ?? d.hotChance)} % | ${role(d.dealId)} | ${cell(d.reason)} |`,
      ),
      "",
      "## Écartés par l'agent",
      "",
      ...(vetoed.length
        ? vetoed.map((v) => `- ${cell(v.title)} — ${cell(v.why)}`)
        : ["- Aucun"]),
    ].join("\n");
    const rows = (plan?.planned ?? []).map((dealId, i) => {
      const d = ranked.find((x) => x.dealId === dealId) ?? {};
      return {
        dealId,
        Deal: d.title,
        Statut: "🕒 Programmé",
        Date: date,
        Créneau: plan.times[i],
        Source: d.sourceId,
        Catégorie: d.categoryId,
        Prix: d.price,
        Score: d.score,
        "Chance hot prévue": d.hotChance,
        "Chance ajustée": d.adjustedHotChance,
        "Pourquoi choisi": d.reason,
      };
    });
    const result = {
      journal: {
        Titre: `Soirée du ${date}`,
        Type: "🌆 Soirée",
        Date: date,
        Candidats: shortlistFile?.candidates ?? 0,
        Programmés: rows.length,
        Résumé: plan?.skipped
          ? plan.skipped
          : `${shortlistFile?.eligible ?? 0} deals éligibles sur ${shortlistFile?.candidates ?? 0}, ${ranked.length} retenus après vérification. Tirage du jour : ${plan?.target ?? 0} publication(s) à ${plan?.times.join(", ") || "—"}.`,
      },
      journalBody,
      rows,
    };
    writeReport(
      `soiree-${date}`,
      `# Soirée du ${date}

${journalBody}
`,
    );
    return result;
  }

  // final
  const published = existsSync(fileOf("published"))
    ? readJson(fileOf("published"))
    : { results: [] };
  const outcomes = published.results.map((e) => ({
    dealId: e.dealId,
    Deal: e.title,
    Date: date,
    Créneau: e.slot,
    Statut: STATUS[e.result] ?? "❌ Échec",
    "Lien Dealabs": e.url,
    Erreur: e.error,
    planned: plan?.planned?.includes(e.dealId) ?? false,
    Source: e.sourceId,
    Catégorie: e.categoryId,
    Prix: e.price,
    Score: e.score,
    "Chance hot prévue": e.hotChance,
    "Chance ajustée": e.adjustedHotChance,
    "Pourquoi choisi": plan?.planned?.includes(e.dealId)
      ? e.reason
      : `Remplaçant : ${e.reason}`,
  }));
  const report = await fetchReport(24, 14);
  const temperatures = report.posted
    .filter(
      (p) =>
        p.temperature !== undefined &&
        report.ledger.some(
          (l) => l.dealId === p.dealId && l.result === "success",
        ),
    )
    .map((p) => ({
      dealId: p.dealId,
      Température: p.temperature,
      "Hot (100°+)": p.temperature >= rules().learning.hotThreshold,
      Expiré: Boolean(p.isExpired),
      "Lien Dealabs": p.url,
    }));
  const count = (status) => outcomes.filter((o) => o.Statut === status).length;
  const journalBodyAppend = outcomes.length
    ? [
        "",
        "## Résultats de la soirée",
        "",
        "| Heure | Deal | Résultat | Lien ou raison |",
        "| --- | --- | --- | --- |",
        ...published.results.map(
          (e) =>
            `| ${hhmm(new Date(e.at))} | ${cell(e.title?.slice(0, 70))} | ${STATUS[e.result] ?? "❌ Échec"}${plan?.planned?.includes(e.dealId) ? "" : " (remplaçant)"} | ${e.url ? `[voir sur Dealabs](${e.url})` : cell(e.error)} |`,
        ),
      ].join("\n")
    : undefined;
  const reasons = outcomes
    .filter((o) => o.Statut !== "✅ Publié")
    .map((o) => `${o.Deal?.slice(0, 40)} : ${o.Erreur ?? o.Statut}`);
  if (journalBodyAppend) {
    appendReport(
      `soiree-${date}`,
      "## Résultats de la soirée",
      journalBodyAppend,
    );
  }
  return {
    journalUpdate: {
      Titre: `Soirée du ${date}`,
      Publiés: count("✅ Publié"),
      résuméAAjouter: plan?.skipped
        ? undefined
        : `Résultat : ${count("✅ Publié")} publié(s), ${count("⏭️ Ignoré")} ignoré(s) par la vérification de page, ${count("♻️ Doublon")} doublon(s), ${count("❌ Échec")} échec(s).${reasons.length ? ` Détail : ${reasons.join(" ; ")}.` : ""}`,
    },
    journalBodyAppend,
    outcomes,
    temperatures,
  };
}

/** Weekly aggregates: the reviewer reasons on these, not on raw rows. */
async function stats(days = 28) {
  const r = rules();
  const report = await fetchReport(24, days);
  const predicted = new Map(
    report.ledger
      .filter((l) => l.result === "success")
      .map((l) => [l.dealId, l]),
  );
  const matureBefore = Date.now() - r.learning.maturedAfterDays * 86_400_000;
  const posts = report.posted
    .filter(
      (p) =>
        p.temperature !== undefined &&
        new Date(p.publishedAt).getTime() <= matureBefore,
    )
    .map((p) => {
      const l = predicted.get(p.dealId);
      return {
        cat: p.categoryId ?? "?",
        src: p.sourceId,
        band: band(p.price),
        hot: p.temperature >= r.learning.hotThreshold,
        temp: p.temperature,
        predicted: l?.hotChance ?? p.hotChance ?? 0,
        byAgents: Boolean(l),
      };
    });
  const summarize = (list) => {
    const temps = list.map((p) => p.temp).sort((a, b) => a - b);
    return {
      n: list.length,
      hot: list.filter((p) => p.hot).length,
      hotRate: list.length
        ? Math.round((100 * list.filter((p) => p.hot).length) / list.length)
        : 0,
      medianTemp: temps.length ? temps[Math.floor(temps.length / 2)] : null,
      meanPredicted: list.length
        ? Math.round(list.reduce((s, p) => s + p.predicted, 0) / list.length)
        : null,
    };
  };
  const groupBy = (key) => {
    const groups = {};
    for (const p of posts) (groups[p[key]] ??= []).push(p);
    return Object.fromEntries(
      Object.entries(groups)
        .filter(([, list]) => list.length >= r.learning.minGroupPosts)
        .map(([k, list]) => [k, summarize(list)]),
    );
  };
  const buckets = {};
  for (const p of posts) {
    const b =
      p.predicted < 10
        ? "0-9"
        : p.predicted < 20
          ? "10-19"
          : p.predicted < 30
            ? "20-29"
            : "30+";
    (buckets[b] ??= []).push(p);
  }
  return {
    days,
    rulesVersion: r.version,
    enoughData: posts.length >= r.learning.minMaturedPosts,
    overall: summarize(posts),
    byAgentsOnly: summarize(posts.filter((p) => p.byAgents)),
    byCategory: groupBy("cat"),
    bySource: groupBy("src"),
    byPriceBand: groupBy("band"),
    calibration: Object.fromEntries(
      Object.entries(buckets).map(([k, list]) => [k, summarize(list)]),
    ),
    failures: report.failures,
    agentAttempts: report.ledger.reduce(
      (acc, l) => ({ ...acc, [l.result]: (acc[l.result] ?? 0) + 1 }),
      {},
    ),
  };
}

/** Same normalisation as src/api/services/desirability.ts. */
const words = (text) =>
  ` ${text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9+]+/g, " ")
    .trim()} `;

/**
 * What the daily tuning (deals-tune) needs, computed here so the agent
 * only compares numbers: per brand and product type, how Dealabs voted on
 * the threads stored in our deals' history (+ our own posts), with a
 * suggested weight; and what each shop/category yields for selection.
 */
async function tuneStats() {
  const { DatabaseSync } = await import("node:sqlite");
  const dbFile = (env.DATABASE_URL ?? "sqlite://./data/dev.db").replace(
    /^sqlite:\/\//,
    "",
  );
  const db = new DatabaseSync(resolve(root, dbFile), { readOnly: true });
  const desirability = readJson(join(root, "config", "desirability.json"));
  const collection = readJson(join(root, "config", "collection.json"));
  const r = rules();
  const brands = Object.keys(desirability.brands);
  const brandOf = (title) => {
    const w = words(title);
    return brands.find((b) => w.includes(words(b)));
  };

  // Every Dealabs thread stored in a deal's history, once, with the deal's category.
  const threads = new Map();
  for (const row of db
    .prepare(
      "SELECT category_id, dealabs_history FROM deals WHERE dealabs_history IS NOT NULL AND dealabs_history != '[]'",
    )
    .all()) {
    let history = [];
    try {
      history = JSON.parse(row.dealabs_history);
    } catch {
      continue;
    }
    for (const t of history) {
      if (t.mine || !t.url || threads.has(t.url)) continue;
      threads.set(t.url, {
        title: t.title ?? "",
        temp: t.temperature ?? 0,
        cat: row.category_id,
      });
    }
  }
  const all = [...threads.values()].filter((t) => t.cat !== "video-games");
  const hotThreshold = r.learning.hotThreshold;
  const overallHot = all.filter((t) => t.temp >= hotThreshold).length;
  const baseLogOdds = Math.log(
    (overallHot + 1) / (all.length - overallHot + 1),
  );
  const summarize = (list, current) => {
    const hot = list.filter((t) => t.temp >= hotThreshold).length;
    const temps = list.map((t) => t.temp).sort((a, b) => a - b);
    // Shrunk toward 0 by the sample size: 10 threads count for half.
    const raw = Math.log((hot + 1) / (list.length - hot + 1)) - baseLogOdds;
    const suggested = Math.max(
      desirability.bounds[0],
      Math.min(
        desirability.bounds[1],
        raw * (list.length / (list.length + 10)),
      ),
    );
    return {
      n: list.length,
      hotRate: Math.round((100 * hot) / list.length),
      medianTemp: temps[Math.floor(temps.length / 2)],
      current,
      suggested: Math.round(suggested * 10) / 10,
    };
  };

  const byBrand = {};
  const noBrand = [];
  for (const t of all) {
    const brand = brandOf(t.title);
    if (brand) (byBrand[brand] ??= []).push(t);
    else if (desirability.noBrandCategories.includes(t.cat)) noBrand.push(t);
  }
  const brandStats = Object.fromEntries(
    Object.entries(byBrand)
      .filter(([, list]) => list.length >= 5)
      .map(([brand, list]) => [
        brand,
        summarize(list, desirability.brands[brand]),
      ])
      .sort((a, b) => b[1].n - a[1].n)
      .slice(0, 40),
  );
  const keywordStats = Object.fromEntries(
    Object.entries(desirability.keywords).map(([pattern, current]) => {
      const variants = pattern.split("|").map(words);
      const list = all.filter((t) =>
        variants.some((v) => words(t.title).includes(v)),
      );
      return [
        pattern,
        list.length >= 5
          ? summarize(list, current)
          : { n: list.length, current },
      ];
    }),
  );

  // Our own posts by brand (matched on our profile).
  const report = await fetchReport(24, 28);
  const ours = {};
  for (const p of report.posted ?? []) {
    if (p.temperature === undefined) continue;
    const brand =
      p.categoryId === "video-games"
        ? "(jeu vidéo)"
        : (brandOf(p.title) ?? "(sans marque connue)");
    const s = (ours[brand] ??= { n: 0, hot: 0, temps: [] });
    s.n++;
    if (p.temperature >= hotThreshold) s.hot++;
    s.temps.push(p.temperature);
  }

  // What each shop/category yields for the selection (last 7 days).
  const since = Date.now() - 7 * 86_400_000;
  const yieldRows = db
    .prepare(
      "SELECT source_id src, category_id cat, COUNT(*) n, SUM(score >= ?) good, ROUND(AVG(hot_chance), 0) hot FROM deals WHERE status = 'active' AND score >= 40 AND last_seen_at >= ? AND source_id IN ('amazon','amazon-watch','cdiscount','lenovo','joybuy','grosbill','leclerc','carrefour') GROUP BY 1, 2 HAVING n >= 3 ORDER BY good DESC LIMIT 30",
    )
    .all(r.minScore, since);

  return {
    threadsAnalysed: all.length,
    overallHotRate: Math.round((100 * overallHot) / Math.max(1, all.length)),
    noBrandPenalty: { ...summarize(noBrand, desirability.noBrandPenalty) },
    brands: brandStats,
    keywords: keywordStats,
    ourPostsByBrand: Object.fromEntries(
      Object.entries(ours).map(([brand, s]) => [
        brand,
        {
          n: s.n,
          hot: s.hot,
          medianTemp: s.temps.sort((a, b) => a - b)[
            Math.floor(s.temps.length / 2)
          ],
        },
      ]),
    ),
    collectionYield7d: yieldRows.map(
      (y) =>
        `${y.src}/${y.cat}: ${y.n} vus, ${y.good} score≥${r.minScore}, hot moy ${y.hot}`,
    ),
    collection: {
      amazon: {
        limit: collection.amazon.limit,
        bounds: collection.amazon.bounds,
        pages: Object.fromEntries(
          Object.entries(collection.amazon.extraPages).map(([k, v]) => [
            k,
            v.enabled,
          ]),
        ),
      },
      cdiscount: {
        limit: collection.cdiscount.limit,
        bounds: collection.cdiscount.bounds,
        pages: Object.fromEntries(
          Object.entries(collection.cdiscount.extraPages).map(([k, v]) => [
            k,
            v.enabled,
          ]),
        ),
      },
    },
    limits: {
      bounds: desirability.bounds,
      maxDailyStep: desirability.maxDailyStep,
    },
  };
}

const DEALABS_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36",
  "accept-language": "fr-FR,fr;q=0.9",
};
const unescapeHtml = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

/** Our threads from the public profile, with the fields the app doesn't keep. */
async function readProfile(user, pages = 3) {
  const posts = [];
  for (let page = 1; page <= pages; page++) {
    const res = await fetch(
      `https://www.dealabs.com/profile/${encodeURIComponent(user)}/bons-plans?page=${page}`,
      { headers: DEALABS_HEADERS, signal: AbortSignal.timeout(20_000) },
    ).catch(() => null);
    if (!res?.ok) break;
    const html = await res.text();
    let found = 0;
    for (const m of html.matchAll(/data-vue3='([^']*)'|data-vue3="([^"]*)"/g)) {
      try {
        const json = JSON.parse(unescapeHtml(m[1] ?? m[2] ?? ""));
        if (json?.name !== "ThreadMainListItemNormalizer") continue;
        const t = json.props.thread;
        found++;
        posts.push({
          id: String(t.threadId),
          title: String(t.title).slice(0, 90),
          url: `https://www.dealabs.com/bons-plans/${t.titleSlug}-${t.threadId}`,
          publishedAt: new Date(Number(t.publishedAt) * 1000).toISOString(),
          temp: Math.round(Number(t.temperature) || 0),
          hot: !!t.isHot,
          expired: !!t.isExpired,
          status: t.status,
          comments: Number(t.commentCount) || 0,
          price: Number(t.price) || 0,
          merchant: t.merchant?.merchantName,
          flags: [
            t.deletedAt && "supprimé",
            t.isLocked && "verrouillé",
            t.isSpamLocked && "spam",
            t.isCommunityFavorite && "coup de cœur",
            t.isTrending && "tendance",
          ].filter(Boolean),
        });
      } catch {
        // Other data-vue3 components.
      }
    }
    if (found === 0) break;
    await sleep(1500);
  }
  return posts;
}

/** The first comments of a thread, read in a headless browser (the API refuses scripts). */
async function readComments(urls) {
  if (urls.length === 0) return {};
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  const out = {};
  try {
    for (const url of urls) {
      const context = await browser.newContext({
        locale: "fr-FR",
        userAgent: DEALABS_HEADERS["user-agent"],
      });
      try {
        const page = await context.newPage();
        await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 45_000,
        });
        await page.waitForTimeout(5000);
        await page.evaluate(() =>
          window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(3000);
        const texts = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '[class*="comment-body"], .commentList-item, article[id^="comment"]',
            ),
          ].map((el) => el.innerText.replace(/\s+/g, " ").trim()),
        );
        // Keep the innermost texts (parents repeat their children).
        const leaves = [...new Set(texts)].filter(
          (t) => t && !texts.some((o) => o !== t && t.includes(o)),
        );
        out[url] = leaves.slice(0, 6).map((t) => t.slice(0, 220));
      } catch {
        out[url] = [];
      } finally {
        await context.close();
      }
      await sleep(2000);
    }
  } finally {
    await browser.close();
  }
  return out;
}

/**
 * The evening debrief's input: our posts of the last 14 days (temperature,
 * comments, status, flags), whether the agents posted them, and the
 * comments of the posts worth understanding (frozen, flagged, debated) —
 * read once per thread and comment count (cached).
 */
async function profileReview() {
  const user = env.DEALABS_USERNAME;
  if (!user) throw new Error("DEALABS_USERNAME missing in .env");
  const since = Date.now() - 14 * 86_400_000;
  const posts = (await readProfile(user)).filter(
    (p) => new Date(p.publishedAt).getTime() >= since,
  );
  const ledger = readLedger(30).filter((e) => e.result === "success");
  const byAgents = (p) => ledger.some((e) => e.url && e.url.includes(p.id));

  const cacheFile = join(outDir, "comments-cache.json");
  const cache = existsSync(cacheFile) ? readJson(cacheFile) : {};
  const worth = posts
    .filter(
      (p) =>
        p.comments > 0 &&
        (p.temp < 20 ||
          p.flags.length ||
          p.status !== "Activated" ||
          p.comments >= 5),
    )
    .filter((p) => cache[p.id]?.count !== p.comments)
    .sort((a, b) => a.temp - b.temp)
    .slice(0, 6);
  const fresh = await readComments(worth.map((p) => p.url));
  for (const p of worth)
    cache[p.id] = { count: p.comments, comments: fresh[p.url] ?? [] };
  writeFileSync(cacheFile, JSON.stringify(cache));

  const hot = posts.filter((p) => p.temp >= rules().learning.hotThreshold);
  return {
    period: "14 derniers jours",
    summary: {
      posts: posts.length,
      parLesAgents: posts.filter(byAgents).length,
      hot: hot.length,
      negatifs: posts.filter((p) => p.temp < 0).length,
      tempMediane:
        posts.map((p) => p.temp).sort((a, b) => a - b)[
          Math.floor(posts.length / 2)
        ] ?? null,
      nonActives: posts.filter((p) => p.status !== "Activated").length,
      signales: posts.filter((p) =>
        p.flags.some((f) => ["supprimé", "verrouillé", "spam"].includes(f)),
      ).length,
    },
    posts: posts.map(
      (p) =>
        `${p.publishedAt.slice(5, 16).replace("T", " ")} | ${p.temp}° | ${p.comments} comm. | ${p.status}${p.expired ? " · expiré" : ""}${p.flags.length ? ` · ${p.flags.join(", ")}` : ""} | ${byAgents(p) ? "agents" : "manuel"} | ${p.price} € | ${p.title}`,
    ),
    comments: Object.fromEntries(
      posts
        .filter((p) => cache[p.id]?.comments?.length)
        .map((p) => [
          `${p.title.slice(0, 50)} (${p.temp}°)`,
          cache[p.id].comments,
        ]),
    ),
  };
}

/** Dealabs merchant names → our source ids (lowercase, letters/digits only). */
const MERCHANT_SOURCES = [
  [/^amazon/, ["amazon", "amazon-watch", "relances"]],
  [/^cdiscount/, ["cdiscount"]],
  [/^aliexpress/, ["aliexpress"]],
  [/^sosh/, ["sosh"]],
  [/^orange/, ["orange"]],
  [/^free/, ["free"]],
  [/^(bouygues|byou)/, ["bouygues"]],
  [/^(redbysfr|sfr)/, ["sfr"]],
  [/^epic/, ["epic"]],
  [/^gog/, ["gog"]],
  [/^(nintendo|eshop)/, ["nintendo"]],
  [/^playstation/, ["playstation"]],
  [/^(xbox|microsoft)/, ["xbox"]],
  [/^steam/, ["steam"]],
  [/^lidl/, ["lidl"]],
  [/^ikea/, ["ikea"]],
  [/^(eleclerc|leclerc)/, ["leclerc"]],
  [/^carrefour/, ["carrefour"]],
  [/^grosbill/, ["grosbill"]],
  [/^nike/, ["nike"]],
  [/^footlocker/, ["footlocker"]],
  [/^castorama/, ["castorama"]],
  [/^lenovo/, ["lenovo"]],
  [/^joybuy/, ["joybuy"]],
  [/^itjustgood/, ["itjustgood"]],
];
const merchantKey = (name) =>
  (name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
const sourcesOfMerchant = (name) =>
  MERCHANT_SOURCES.find(([re]) => re.test(merchantKey(name)))?.[1] ?? [];
const median = (values) => {
  const sorted = values.filter((v) => v !== undefined).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined;
};

/** Threads of a Dealabs listing page (hot, new…), with merchant and group. */
async function readDealabsListing(path, pages, spacingMs = 1_500) {
  const threads = [];
  for (let page = 1; page <= pages; page++) {
    if (page > 1) await sleep(spacingMs);
    const res = await fetch(`https://www.dealabs.com/${path}?page=${page}`, {
      headers: DEALABS_HEADERS,
      signal: AbortSignal.timeout(20_000),
    }).catch(() => null);
    if (!res?.ok) break;
    const html = await res.text();
    for (const m of html.matchAll(/data-vue3='([^']*)'|data-vue3="([^"]*)"/g)) {
      try {
        const json = JSON.parse(unescapeHtml(m[1] ?? m[2] ?? ""));
        if (json?.name !== "ThreadMainListItemNormalizer") continue;
        const t = json.props?.thread;
        if (!t?.threadId || t.type !== "Deal") continue;
        threads.push({
          id: String(t.threadId),
          title: String(t.title ?? ""),
          merchant: t.merchant?.merchantName ?? t.linkHost ?? "(sans marchand)",
          group: t.mainGroup?.threadGroupName ?? "?",
          temp: Math.round(Number(t.temperature) || 0),
        });
      } catch {
        // Not a thread payload.
      }
    }
  }
  return [...new Map(threads.map((t) => [t.id, t])).values()];
}

/**
 * Everything the deals-sources skill needs in one small JSON: each
 * source's yield (deals seen, visible, publishable, our posts and their
 * temperatures), run time and errors, its schedule; then what goes hot
 * on Dealabs, by merchant and category, and which of it we don't cover.
 */
async function sourcesReview(days = 7) {
  const { DatabaseSync } = await import("node:sqlite");
  const dbFile = (env.DATABASE_URL ?? "sqlite://./data/dev.db").replace(
    /^sqlite:\/\//,
    "",
  );
  const db = new DatabaseSync(resolve(root, dbFile), { readOnly: true });
  const r = rules();
  const collection = readJson(join(root, "config", "collection.json"));
  const since = Date.now() - days * 86_400_000;

  const sources = db
    .prepare("SELECT id, enabled, last_error FROM sources")
    .all();
  const yieldRows = db
    .prepare(
      `SELECT source_id src, COUNT(*) seen,
        SUM(status = 'active' AND score >= 40) visible,
        SUM(status = 'active' AND score >= ? AND hot_chance >= ?) publishable,
        MAX(score) best,
        ROUND(AVG(CASE WHEN score >= 40 THEN hot_chance END), 0) hot
       FROM deals WHERE last_seen_at >= ? GROUP BY 1`,
    )
    .all(r.minScore, r.minHotChance, since);
  const catRows = db
    .prepare(
      `SELECT source_id src, category_id cat, COUNT(*) n FROM deals
       WHERE last_seen_at >= ? AND status = 'active' AND score >= 40
       GROUP BY 1, 2 ORDER BY n DESC`,
    )
    .all(since);

  // Run times and freshness, from the app's run log.
  const runsFile = join(outDir, "collection-runs.jsonl");
  const runs = existsSync(runsFile)
    ? readFileSync(runsFile, "utf8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((run) => new Date(run.at).getTime() >= since)
    : [];
  const runStats = {};
  for (const run of runs) {
    for (const s of run.sources) {
      const st = (runStats[s.id] ??= {
        runs: 0,
        errors: 0,
        ms: [],
        withNew: 0,
        newVisible: 0,
      });
      st.runs++;
      if (s.error) st.errors++;
      if (s.ms !== undefined) st.ms.push(s.ms);
      if ((s.createdVisible ?? 0) > 0) st.withNew++;
      st.newVisible += s.createdVisible ?? 0;
    }
  }

  // Our posts (agents and manual) with their temperature, by source.
  const report = existsSync(fileOf("report"))
    ? readJson(fileOf("report"))
    : await fetchReport(24, 30);
  const ours = {};
  for (const p of report.posted ?? []) {
    const o = (ours[p.sourceId ?? "?"] ??= { n: 0, hot: 0, temps: [] });
    o.n++;
    if ((p.temperature ?? 0) >= r.learning.hotThreshold) o.hot++;
    if (p.temperature !== undefined) o.temps.push(p.temperature);
  }

  const perSource = sources
    .map((s) => {
      const y = yieldRows.find((row) => row.src === s.id) ?? {};
      const st = runStats[s.id];
      const o = ours[s.id];
      const sched = collection.sources?.[s.id] ?? {};
      return {
        id: s.id,
        on: !!s.enabled && sched.enabled !== false,
        locked: (collection.lockedSources ?? []).includes(s.id) || undefined,
        everyHours: sched.everyHours ?? 1,
        notPublished: r.excludedSources.includes(s.id) || undefined,
        seen: y.seen ?? 0,
        visible: y.visible ?? 0,
        publishable: y.publishable ?? 0,
        bestScore: y.best ?? 0,
        avgHotChance: y.hot ?? 0,
        categories: catRows
          .filter((row) => row.src === s.id)
          .slice(0, 3)
          .map((row) => `${row.cat}:${row.n}`)
          .join(" "),
        runs: st?.runs ?? 0,
        medianSec: st ? Math.round((median(st.ms) ?? 0) / 1000) : undefined,
        errorRate: st ? Math.round((100 * st.errors) / st.runs) : undefined,
        runsWithNewVisible: st?.withNew,
        newVisible: st?.newVisible,
        ourPosts: o
          ? `${o.n} posts, ${o.hot} hot, médiane ${median(o.temps) ?? "?"}°`
          : undefined,
        lastError: s.last_error ? s.last_error.slice(0, 80) : undefined,
      };
    })
    .sort((a, b) => b.publishable - a.publishable || b.visible - a.visible);

  // What the Dealabs community makes hot, and what we don't cover.
  const hot = await readDealabsListing("hot", 10);
  const summarize = (list) => ({
    n: list.length,
    medianTemp: median(list.map((t) => t.temp)),
  });
  const byMerchant = {};
  const byGroup = {};
  for (const t of hot) {
    (byMerchant[t.merchant] ??= []).push(t);
    (byGroup[t.group] ??= []).push(t);
  }
  const covered = (t) => sourcesOfMerchant(t.merchant).length > 0;

  return {
    days,
    rules: {
      minScore: r.minScore,
      minHotChance: r.minHotChance,
      excludedSources: r.excludedSources,
    },
    collection: {
      lockedSources: collection.lockedSources,
      everyHoursBounds: [1, 24],
      amazon: {
        limit: collection.amazon.limit,
        bounds: collection.amazon.bounds,
        pages: Object.fromEntries(
          Object.entries(collection.amazon.extraPages).map(([k, v]) => [
            k,
            v.enabled,
          ]),
        ),
      },
      cdiscount: {
        limit: collection.cdiscount.limit,
        bounds: collection.cdiscount.bounds,
        pages: Object.fromEntries(
          Object.entries(collection.cdiscount.extraPages).map(([k, v]) => [
            k,
            v.enabled,
          ]),
        ),
      },
    },
    runsLogged: runs.length,
    perSource,
    dealabsHot: {
      threads: hot.length,
      coveredShare: Math.round(
        (100 * hot.filter(covered).length) / Math.max(1, hot.length),
      ),
      byGroup: Object.entries(byGroup)
        .map(([group, list]) => ({
          group,
          ...summarize(list),
          covered: list.filter(covered).length,
        }))
        .sort((a, b) => b.n - a.n),
      merchants: Object.entries(byMerchant)
        .map(([merchant, list]) => ({
          merchant,
          ...summarize(list),
          groups: [...new Set(list.map((t) => t.group))].slice(0, 3).join(", "),
          ourSources: sourcesOfMerchant(merchant).join(",") || "NON COUVERT",
          example: list
            .slice()
            .sort((a, b) => b.temp - a.temp)[0]
            .title.slice(0, 70),
        }))
        .sort((a, b) => b.n - a.n)
        .slice(0, 30),
    },
    rejectedSources: collection.rejectedSources ?? {},
  };
}

const BLOCK_SIGNS =
  /captcha|datadome|just a moment|access denied|cf-chl|perimeterx|are you a robot|robot check|incapsula/i;

/**
 * Can a candidate shop be read without a browser? Status, size, prices
 * and structured data in the HTML, anti-bot signs. A first check before
 * writing a source proposal — never a scraper.
 */
async function probe(url) {
  if (!url.startsWith("https://")) throw new Error("probe: https URL only");
  const started = Date.now();
  const res = await fetch(url, {
    headers: {
      ...DEALABS_HEADERS,
      accept: "text/html,application/json;q=0.9,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(25_000),
  }).catch((error) => ({ error: String(error?.message ?? error) }));
  if ("error" in res) return { url, ok: false, error: res.error };
  const body = await res.text();
  const ldJson = [
    ...body.matchAll(
      /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  return {
    url,
    finalUrl: res.url,
    status: res.status,
    ms: Date.now() - started,
    bytes: body.length,
    contentType: res.headers.get("content-type"),
    title: body
      .match(/<title[^>]*>([^<]*)/i)?.[1]
      ?.trim()
      .slice(0, 100),
    blocked: BLOCK_SIGNS.test(body.slice(0, 50_000)) || res.status === 403,
    euroPrices: (body.match(/\d+[,.]\d{2}\s?(€|&euro;|EUR)/g) ?? []).length,
    ldJsonBlocks: ldJson.length,
    ldJsonOffers: ldJson.filter((m) => /"price"|"lowPrice"/.test(m[1])).length,
    embeddedState:
      /__NEXT_DATA__|self\.__next_f|__NUXT__|__PRELOADED_STATE__/.test(body),
    sample: body
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 300),
  };
}

const [command, ...args] = process.argv.slice(2);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

const startedAt = Date.now();

/** Remote mode: the VM's configs, ledger and today's files, into this checkout. */
async function pullFromVm() {
  for (const [name, file] of Object.entries(CONFIG_FILES)) {
    const res = await api("GET", `/agent/config/${name}`);
    if (res.ok && typeof res.body?.content === "string") {
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(join(root, "config", file), res.body.content);
    }
  }
  const pulls = [
    "ledger.jsonl",
    ...DATA_KINDS.map((k) => `${k}-${today()}.json`),
  ];
  for (const name of pulls) {
    const res = await api("GET", `/agent/data/${name}`);
    if (res.ok && typeof res.body?.content === "string") {
      writeFileSync(join(outDir, name), res.body.content);
    }
  }
}

const changedSince = (dir, pattern) =>
  existsSync(dir)
    ? readdirSync(dir).filter(
        (f) => pattern.test(f) && statSync(join(dir, f)).mtimeMs >= startedAt,
      )
    : [];

/** Remote mode: today's files and the reports this command wrote, to the VM. */
async function pushToVm() {
  const agent = process.env.DEALRADAR_AGENT ?? `dealradar.mjs ${command}`;
  const kinds = new RegExp(
    `^(${DATA_KINDS.join("|")})-\\d{4}-\\d{2}-\\d{2}\\.json$`,
  );
  for (const name of changedSince(outDir, kinds)) {
    const res = await api("PUT", `/agent/data/${name}`, {
      content: readFileSync(join(outDir, name), "utf8"),
      agent,
    });
    if (!res.ok) process.stderr.write(`push ${name}: ${res.status}\n`);
  }
  for (const name of changedSince(
    join(outDir, "reports"),
    /^[a-z0-9-]+\.md$/,
  )) {
    const res = await api("PUT", `/agent/reports/${name.slice(0, -3)}`, {
      markdown: readFileSync(join(outDir, "reports", name), "utf8"),
      agent,
    });
    if (!res.ok) process.stderr.write(`push report ${name}: ${res.status}\n`);
  }
}

async function pushConfig(name, agent, reason, changelogFile) {
  if (!remote) throw new Error("push-config needs DEALRADAR_URL");
  if (!CONFIG_FILES[name]) {
    throw new Error(`unknown config: ${Object.keys(CONFIG_FILES).join(", ")}`);
  }
  const res = await api("PUT", `/agent/config/${name}`, {
    content: readFileSync(join(root, "config", CONFIG_FILES[name]), "utf8"),
    agent: agent ?? "agent",
    reason,
    changelog: changelogFile ? readFileSync(changelogFile, "utf8") : undefined,
  });
  return {
    status: res.status,
    ...(typeof res.body === "object" ? res.body : { body: res.body }),
  };
}

try {
  if (remote && !["probe", "push-config", "push-proposal"].includes(command)) {
    await pullFromVm();
  }
  switch (command) {
    case "ensure-server":
      print(await ensureServer());
      break;
    case "report": {
      const [hours = "24", days = "30"] = args;
      const report = await fetchReport(hours, days);
      // Only counts on stdout: the file is what agents read.
      print({
        file: fileOf("report"),
        candidates: report.candidates.length,
        posted: report.posted.length,
        withTemperature: report.posted.filter(
          (p) => p.temperature !== undefined,
        ).length,
        ledger: report.ledger.length,
      });
      break;
    }
    case "shortlist":
      print(await shortlist());
      break;
    case "publish-queue":
      if (!args[0]) throw new Error("usage: publish-queue <queue.json>");
      print(await publishQueue(args[0], args.includes("--now")));
      break;
    case "notion-log":
      if (!["plan", "final"].includes(args[0]))
        throw new Error("usage: notion-log <plan|final>");
      print(await notionLog(args[0]));
      break;
    case "stats":
      print(await stats(Number(args[0] ?? 28)));
      break;
    case "tune-stats":
      print(await tuneStats());
      break;
    case "profile-review":
      print(await profileReview());
      break;
    case "posted": {
      const report = existsSync(fileOf("report"))
        ? readJson(fileOf("report"))
        : await fetchReport(24, 28);
      print({
        failures: report.failures,
        ledger: report.ledger.length,
        otherPosts: report.otherPosts?.length ?? 0,
      });
      for (const p of report.posted ?? []) {
        process.stdout.write(
          `${[p.dealId, p.publishedAt?.slice(0, 10), p.sourceId, p.categoryId, p.price, p.score, p.hotChance, p.temperature ?? "?", p.isHot ? "HOT" : "", p.isExpired ? "expired" : "", p.title].join(" | ")}\n`,
        );
      }
      break;
    }
    case "check-shop": {
      if (!args[0]) throw new Error("usage: check-shop <dealId>");
      const res = await api(
        "GET",
        `/deals/${encodeURIComponent(args[0])}/publish-check`,
      );
      print(
        res.ok
          ? res.body
          : { ok: false, reason: `check failed (${res.status})` },
      );
      break;
    }
    case "publish":
      if (!args[0]) throw new Error("usage: publish <dealId>");
      print(await publish(args[0]));
      break;
    case "sources-review":
      print(await sourcesReview(Number(args[0] ?? 7)));
      break;
    case "probe":
      if (!args[0]) throw new Error("usage: probe <url>");
      print(await probe(args[0]));
      break;
    case "ledger":
      print(readLedger(Number(args[0] ?? 60)));
      break;
    case "push-config":
      if (!args[0])
        throw new Error(
          "usage: push-config <name> [agent] [reason] [changelog.md]",
        );
      print(await pushConfig(args[0], args[1], args[2], args[3]));
      break;
    case "push-proposal": {
      if (!remote) throw new Error("push-proposal needs DEALRADAR_URL");
      if (!args[0]) throw new Error("usage: push-proposal <file.md> [agent]");
      const slug = args[0]
        .split(/[\\/]/)
        .pop()
        .replace(/^code-proposal-/, "")
        .replace(/\.md$/, "");
      const res = await api("PUT", `/agent/proposals/${slug}`, {
        markdown: readFileSync(args[0], "utf8"),
        agent: args[1] ?? "agent",
      });
      print({ status: res.status, slug });
      break;
    }
    default:
      throw new Error(
        "commands: ensure-server | report | shortlist | publish-queue <file> | notion-log <plan|final> | stats [days] | posted | check-shop <id> | publish <id> | ledger [days] | sources-review [days] | probe <url> | push-config <name> | push-proposal <file>",
      );
  }
  if (remote && !["probe", "push-config", "push-proposal"].includes(command)) {
    await pushToVm();
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
