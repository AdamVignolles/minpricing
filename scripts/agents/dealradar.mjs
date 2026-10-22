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
 */
import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
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
  throw new Error(`DealRadar server not reachable on ports ${ports.join(", ")}`);
}

async function api(method, path) {
  const { base, cookie } = await login();
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { cookie },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function ensureServer() {
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
  const res = await api("GET", `/admin/agent-report?hours=${hours}&days=${days}`);
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
  price < 30 ? "<30" : price < 100 ? "30-100" : price < 300 ? "100-300" : ">300";

function isPublishDay(r, date = new Date()) {
  // publishDays: 1 = Monday … 7 = Sunday.
  const weekday = date.getDay() === 0 ? 7 : date.getDay();
  return r.publishDays.includes(weekday);
}

async function shortlist() {
  const r = rules();
  const report = await fetchReport(24, 0);
  const tried = triedToday();
  const ranked = report.candidates
    .filter((c) => !r.excludedSources.includes(c.sourceId) && !tried.has(c.id))
    .map((c) => {
      const adjusted =
        (c.hotChance ?? 0) +
        (r.categoryAdjust[c.categoryId] ?? 0) +
        (r.sourceAdjust[c.sourceId] ?? 0) +
        (r.priceBandAdjust[band(c.price)] ?? 0);
      return { ...c, adjusted };
    })
    .filter((c) => c.score >= r.minScore && c.adjusted >= r.minHotChance)
    .sort((a, b) => b.adjusted - a.adjusted || b.score - a.score)
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
    eligible: ranked.length,
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
    error: res.ok ? undefined : String(res.body?.message ?? res.body).slice(0, 300),
  };
}

async function publishQueue(file) {
  const r = rules();
  const queue = readJson(resolve(file));
  // Old queues had items + backups; new ones a single ranked list.
  const ranked = queue.ranked ?? [...(queue.items ?? []), ...(queue.backups ?? [])];
  const planFile = fileOf("plan");
  if (!isPublishDay(r)) {
    const plan = { date: today(), skipped: "pas de publication ce jour (week-end)", times: [] };
    writeFileSync(planFile, JSON.stringify(plan));
    return plan;
  }

  const doneToday = () =>
    readLedger(1).filter((e) => e.date === today() && e.result === "success");
  const target = Math.max(
    0,
    r.perDay.min + Math.floor(Math.random() * (r.perDay.max - r.perDay.min + 1)) -
      doneToday().length,
  );
  const from = new Date(Math.max(atToday(r.window.start).getTime(), Date.now() + 5 * 60_000));
  const times = randomTimes(Math.min(target, ranked.length), from, atToday(r.window.end), r.minGapMinutes);
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
      const sameCategory = doneToday().filter((e) => e.categoryId === candidate.categoryId).length;
      if (candidate.categoryId && sameCategory >= r.maxPerCategoryPerDay) continue;
      attempts++;
      tried.add(candidate.dealId);
      const outcome = await publish(candidate.dealId).catch((error) => ({
        result: "failed",
        error: String(error).slice(0, 300),
      }));
      const entry = { date: today(), at: new Date().toISOString(), slot: hhmm(time), ...candidate, ...outcome };
      appendFileSync(ledgerFile, `${JSON.stringify(entry)}\n`);
      results.push(entry);
      if (outcome.result === "success") break;
    }
  }
  writeFileSync(fileOf("published"), JSON.stringify({ date: today(), plan, results }, null, 2));
  return { plan, results };
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
  const queue = existsSync(fileOf("queue")) ? readJson(fileOf("queue")) : { ranked: [] };
  const ranked = queue.ranked ?? [...(queue.items ?? []), ...(queue.backups ?? [])];
  const plan = existsSync(fileOf("plan")) ? readJson(fileOf("plan")) : undefined;
  const shortlistFile = existsSync(fileOf("shortlist")) ? readJson(fileOf("shortlist")) : undefined;

  if (mode === "plan") {
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
    return {
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
      rows,
    };
  }

  // final
  const published = existsSync(fileOf("published")) ? readJson(fileOf("published")) : { results: [] };
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
    "Pourquoi choisi": plan?.planned?.includes(e.dealId) ? e.reason : `Remplaçant : ${e.reason}`,
  }));
  const report = await fetchReport(24, 14);
  const temperatures = report.posted
    .filter((p) => p.temperature !== undefined && report.ledger.some((l) => l.dealId === p.dealId && l.result === "success"))
    .map((p) => ({
      dealId: p.dealId,
      Température: p.temperature,
      "Hot (100°+)": p.temperature >= rules().learning.hotThreshold,
      Expiré: Boolean(p.isExpired),
      "Lien Dealabs": p.url,
    }));
  const count = (status) => outcomes.filter((o) => o.Statut === status).length;
  const reasons = outcomes.filter((o) => o.Statut !== "✅ Publié").map((o) => `${o.Deal?.slice(0, 40)} : ${o.Erreur ?? o.Statut}`);
  return {
    journalUpdate: {
      Titre: `Soirée du ${date}`,
      Publiés: count("✅ Publié"),
      résuméAAjouter: plan?.skipped
        ? undefined
        : `Résultat : ${count("✅ Publié")} publié(s), ${count("⏭️ Ignoré")} ignoré(s) par la vérification de page, ${count("♻️ Doublon")} doublon(s), ${count("❌ Échec")} échec(s).${reasons.length ? ` Détail : ${reasons.join(" ; ")}.` : ""}`,
    },
    outcomes,
    temperatures,
  };
}

/** Weekly aggregates: the reviewer reasons on these, not on raw rows. */
async function stats(days = 28) {
  const r = rules();
  const report = await fetchReport(24, days);
  const predicted = new Map(report.ledger.filter((l) => l.result === "success").map((l) => [l.dealId, l]));
  const matureBefore = Date.now() - r.learning.maturedAfterDays * 86_400_000;
  const posts = report.posted
    .filter((p) => p.temperature !== undefined && new Date(p.publishedAt).getTime() <= matureBefore)
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
      hotRate: list.length ? Math.round((100 * list.filter((p) => p.hot).length) / list.length) : 0,
      medianTemp: temps.length ? temps[Math.floor(temps.length / 2)] : null,
      meanPredicted: list.length ? Math.round(list.reduce((s, p) => s + p.predicted, 0) / list.length) : null,
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
    const b = p.predicted < 10 ? "0-9" : p.predicted < 20 ? "10-19" : p.predicted < 30 ? "20-29" : "30+";
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
    calibration: Object.fromEntries(Object.entries(buckets).map(([k, list]) => [k, summarize(list)])),
    failures: report.failures,
    agentAttempts: report.ledger.reduce((acc, l) => ({ ...acc, [l.result]: (acc[l.result] ?? 0) + 1 }), {}),
  };
}

const [command, ...args] = process.argv.slice(2);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);

try {
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
        withTemperature: report.posted.filter((p) => p.temperature !== undefined).length,
        ledger: report.ledger.length,
      });
      break;
    }
    case "shortlist":
      print(await shortlist());
      break;
    case "publish-queue":
      if (!args[0]) throw new Error("usage: publish-queue <queue.json>");
      print(await publishQueue(args[0]));
      break;
    case "notion-log":
      if (!["plan", "final"].includes(args[0])) throw new Error("usage: notion-log <plan|final>");
      print(await notionLog(args[0]));
      break;
    case "stats":
      print(await stats(Number(args[0] ?? 28)));
      break;
    case "posted": {
      const report = existsSync(fileOf("report")) ? readJson(fileOf("report")) : await fetchReport(24, 28);
      print({ failures: report.failures, ledger: report.ledger.length, otherPosts: report.otherPosts?.length ?? 0 });
      for (const p of report.posted ?? []) {
        process.stdout.write(
          `${[p.dealId, p.publishedAt?.slice(0, 10), p.sourceId, p.categoryId, p.price, p.score, p.hotChance, p.temperature ?? "?", p.isHot ? "HOT" : "", p.isExpired ? "expired" : "", p.title].join(" | ")}\n`,
        );
      }
      break;
    }
    case "check-shop": {
      if (!args[0]) throw new Error("usage: check-shop <dealId>");
      const res = await api("GET", `/deals/${encodeURIComponent(args[0])}/publish-check`);
      print(res.ok ? res.body : { ok: false, reason: `check failed (${res.status})` });
      break;
    }
    case "publish":
      if (!args[0]) throw new Error("usage: publish <dealId>");
      print(await publish(args[0]));
      break;
    case "ledger":
      print(readLedger(Number(args[0] ?? 60)));
      break;
    default:
      throw new Error(
        "commands: ensure-server | report | shortlist | publish-queue <file> | notion-log <plan|final> | stats [days] | posted | check-shop <id> | publish <id> | ledger [days]",
      );
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
  process.exit(1);
}
