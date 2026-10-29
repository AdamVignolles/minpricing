#!/usr/bin/env node
/**
 * Writes DealRadar's live status into the « note » card of the Lore
 * project board (https://lore.alepha.dev/minpricing), so the project's
 * landing page shows how the app is doing, not only how the work is.
 *
 * Reads the production app with the agent token (GET only) and updates
 * one card through Lore's dashboard API. The card is found by its title
 * line, and created when missing.
 *
 *   DEALRADAR_URL, DEALRADAR_TOKEN   the app (agent token)
 *   LORE_API_KEY                     Lore, project owner or admin
 *   LORE_URL      default https://lore.alepha.dev
 *   LORE_PROJECT_ID  default 79
 *
 * Usage: node scripts/lore-board.mjs [--dry-run]
 * Behind the cloud proxy, run it with NODE_USE_ENV_PROXY=1.
 */

const TITLE = "### DealRadar — état";
const dryRun = process.argv.includes("--dry-run");

const app = process.env.DEALRADAR_URL?.replace(/\/$/, "");
const appToken = process.env.DEALRADAR_TOKEN;
const loreKey = process.env.LORE_API_KEY;
const lore = (process.env.LORE_URL ?? "https://lore.alepha.dev").replace(
  /\/$/,
  "",
);
const projectId = Number(process.env.LORE_PROJECT_ID ?? 79);

if (!app || !appToken || (!loreKey && !dryRun)) {
  console.error("DEALRADAR_URL, DEALRADAR_TOKEN and LORE_API_KEY are required");
  process.exit(2);
}

const get = async (path) => {
  try {
    const res = await fetch(`${app}${path}`, {
      headers: { authorization: `Bearer ${appToken}` },
    });
    return res.ok ? await res.json() : undefined;
  } catch {
    return undefined;
  }
};

const loreCall = async (method, path, body) => {
  const res = await fetch(`${lore}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${loreKey}`,
      "content-type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
};

const paris = (iso, opts) =>
  new Date(iso).toLocaleString("fr-FR", { timeZone: "Europe/Paris", ...opts });
const hm = (iso) => paris(iso, { hour: "2-digit", minute: "2-digit" });
const dm = (iso) =>
  paris(iso, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const [overview, pubs, health, schedule, admin, session, version] =
  await Promise.all([
    get("/api/stats/overview"),
    get("/api/stats/publications"),
    get("/api/agents/health"),
    get("/api/schedule"),
    get("/api/admin/stats"),
    get("/api/dealabs/session"),
    get("/version"),
  ]);

const unknown = "_illisible_";
const lines = [TITLE, ""];

// Status first: what needs a human.
const alerts = [];
if (session && !session.connected)
  alerts.push("🔴 Session Dealabs déconnectée : publication auto bloquée");
const missed = health?.routines?.filter((r) => r.status === "missed") ?? [];
if (missed.length)
  alerts.push(`🔴 Routine manquée : ${missed.map((r) => r.name).join(", ")}`);
const failing =
  admin?.sources?.filter(
    (s) =>
      s.enabled &&
      s.type !== "manual" &&
      s.lastErrorAt &&
      (!s.lastSuccessAt || s.lastErrorAt > s.lastSuccessAt),
  ) ?? [];
if (failing.length)
  alerts.push(
    `🟠 Sources en erreur : ${failing.map((s) => s.name).join(", ")}`,
  );
if (pubs?.failedAttempts)
  alerts.push(`🟠 ${pubs.failedAttempts} publication(s) échouée(s)`);
lines.push(alerts.length ? alerts.join("  \n") : "🟢 Rien à signaler", "");

// Publishing on Dealabs.
if (pubs) {
  lines.push(
    "**Dealabs**",
    `- ${pubs.posted} deals publiés, dont ${pubs.postedLast7d} sur 7 jours`,
    `- Température moyenne ${pubs.averageTemperature ?? "—"}° · ${pubs.hotPosts}/${pubs.totalPosts} hot`,
    `- ${pubs.pendingDrafts} brouillons en attente${pubs.lastPostedAt ? ` · dernier post le ${dm(pubs.lastPostedAt)}` : ""}`,
  );
  const best = pubs.bestPosts?.[0];
  if (best)
    lines.push(`- Meilleur post : ${best.title} (${best.temperature}°)`);
} else lines.push(`**Dealabs** ${unknown}`);
lines.push("");

// Tonight.
const entries = (schedule?.entries ?? []).filter(
  (e) => !e.dryRun && e.status !== "cancelled",
);
if (schedule) {
  const done = entries.filter((e) => e.status === "done").length;
  const next = entries
    .filter((e) => e.status === "planned")
    .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))[0];
  lines.push(
    `**Ce soir** ${entries.length ? `${done}/${entries.length} publiés${next ? ` · prochain à ${hm(next.plannedAt)}` : ""}` : "rien de planifié"}`,
  );
} else lines.push(`**Ce soir** ${unknown}`);

// Routines.
if (health?.routines) {
  const label = { ok: "✅", running: "⏳", missed: "❌" };
  lines.push(
    `**Routines** ${health.routines.map((r) => `${label[r.status] ?? "?"} ${r.name}`).join(" · ")}`,
  );
} else lines.push(`**Routines** ${unknown}`);

// Collection and catalogue.
if (admin) {
  lines.push(
    `**Collecte** ${admin.running ? "en cours" : `prochaine à ${hm(admin.nextRunAt)}`} · ${admin.visibleDeals} deals visibles / ${admin.activeDeals} actifs`,
  );
} else lines.push(`**Collecte** ${unknown}`);
if (overview?.totals) {
  const t = overview.totals;
  lines.push(
    `**Catalogue** ${t.newLast24h} nouveaux en 24 h, ${t.newLast7d} en 7 j · ${t.dealsWithDiscount} remisés`,
  );
}

// What runs in production.
if (version)
  lines.push(
    `**Production** \`${version.commit}\` · build du ${dm(version.build.date)}`,
  );

lines.push("", `_Mis à jour le ${dm(new Date().toISOString())} (Paris)_`);
const markdown = lines.join("\n").slice(0, 4000);

if (dryRun) {
  console.log(markdown);
  process.exit(0);
}

const { cards } = await loreCall(
  "GET",
  `/projects/${projectId}/dashboard/cards`,
);
const card = cards.find(
  (c) => c.metric === "note" && c.filters?.markdown?.startsWith(TITLE),
);
if (card) {
  await loreCall("PATCH", `/projects/${projectId}/dashboard/cards/${card.id}`, {
    filters: { markdown },
  });
  console.log(`card ${card.id} updated`);
} else {
  const created = await loreCall(
    "POST",
    `/projects/${projectId}/dashboard/cards`,
    {
      metric: "note",
      scope: { kind: "projects", projectIds: [projectId] },
      filters: { markdown },
      size: 2,
      height: 2,
    },
  );
  console.log(`card ${created?.id ?? "?"} created`);
}
