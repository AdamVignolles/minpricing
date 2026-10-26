import {
  Accordion,
  Anchor,
  Badge,
  Box,
  Button,
  Code,
  Grid,
  Group,
  Modal,
  NumberInput,
  Paper,
  Progress,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  TextInput,
  ThemeIcon,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import {
  type FC,
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";

import type { AdminController } from "../../api/controllers/AdminController.ts";
import type { ProductsController } from "../../api/controllers/ProductsController.ts";
import {
  COLLECTION_FINISHED_EVENT,
  COLLECTION_STARTED_EVENT,
} from "../components/layout/CollectionProgressAside.tsx";
import * as f from "../components/ui/format.ts";
import Icon, { type IconName } from "../components/ui/Icon.tsx";
import Section from "../components/ui/Section.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import StatTile from "../components/ui/StatTile.tsx";
import { useNow } from "../components/ui/useNow.ts";
import type {
  CollectionRun,
  CollectionRunLogEntry,
  RefItem,
  TrackedProduct,
} from "../types.ts";

interface AdminSource {
  id: string;
  name: string;
  type: string;
  enabled: boolean;
  lastRunAt?: string;
  lastSuccessAt?: string;
  lastErrorAt?: string;
  lastError?: string;
  activeDeals: number;
  visibleDeals: number;
  scheduled: boolean;
  everyHours: number;
  locked: boolean;
  lastDurationMs?: number;
  lastCollected?: number;
  lastNewVisible?: number;
}

interface AdminStats {
  activeDeals: number;
  expiredDeals: number;
  draftsPending: number;
  trackedProducts: number;
  priceObservations: number;
  visibleDeals: number;
  nextRunAt: string;
  running: boolean;
  sources: AdminSource[];
}

export interface AdminPageProps {
  stats: AdminStats;
  products: TrackedProduct[];
  runs: CollectionRun[];
  sources: RefItem[];
  tab?: string;
}

// ── Sources: families and health ────────────────────────────────────────

/** Sources grouped the way you think about them, not alphabetically. */
const FAMILIES: Array<{ label: string; icon: IconName; ids: string[] }> = [
  {
    label: "Grandes plateformes",
    icon: "store",
    ids: [
      "amazon",
      "amazon-watch",
      "relances",
      "cdiscount",
      "aliexpress",
      "joybuy",
    ],
  },
  {
    label: "Informatique",
    icon: "package",
    ids: ["lenovo", "grosbill", "itjustgood"],
  },
  {
    label: "Magasins & maison",
    icon: "tag",
    ids: ["leclerc", "carrefour", "lidl", "ikea", "castorama"],
  },
  { label: "Mode & sport", icon: "tag", ids: ["nike", "footlocker"] },
  {
    label: "Jeux vidéo",
    icon: "bolt",
    ids: [
      "steam",
      "epic",
      "gog",
      "nintendo",
      "playstation",
      "xbox",
      "freegames",
    ],
  },
  {
    label: "Forfaits & box",
    icon: "inbox",
    ids: ["orange", "free", "bouygues", "sfr", "sosh"],
  },
  { label: "Saisie manuelle", icon: "settings", ids: ["manual"] },
];

const familyOf = (id: string) =>
  FAMILIES.find((family) => family.ids.includes(id))?.label ?? "Autres";

type HealthKey = "ok" | "error" | "off" | "paused" | "never";

const HEALTH: Record<HealthKey, { label: string; color: string }> = {
  ok: { label: "En service", color: "teal" },
  error: { label: "En erreur", color: "red" },
  paused: { label: "Coupée par l'agent", color: "gray" },
  off: { label: "Désactivée", color: "gray" },
  never: { label: "Jamais exécutée", color: "gray" },
};

/**
 * A source whose last error is more recent than its last success is
 * failing *now*, whatever its history. "Coupée" = switched off by the
 * deals-sources agent in config/collection.json; "désactivée" = in base.
 */
const healthOf = (source: AdminSource): HealthKey => {
  if (!source.enabled) return "off";
  if (!source.scheduled) return "paused";
  if (!source.lastRunAt) return "never";
  const failing =
    source.lastErrorAt &&
    (!source.lastSuccessAt ||
      new Date(source.lastErrorAt) > new Date(source.lastSuccessAt));
  return failing ? "error" : "ok";
};

const frequency = (source: AdminSource) =>
  !source.enabled || !source.scheduled
    ? "—"
    : source.everyHours > 1
      ? `toutes les ${source.everyHours} h`
      : "chaque heure";

const Dot: FC<{ color: string; size?: number }> = ({ color, size = 8 }) => (
  <Box
    component="span"
    w={size}
    h={size}
    style={{
      borderRadius: "50%",
      background: `var(--mantine-color-${color}-6)`,
      display: "inline-block",
      flexShrink: 0,
    }}
  />
);

// ── Runs: what the job execution logs say ───────────────────────────────

interface SourceOutcome {
  sourceId: string;
  collected?: number;
  created?: number;
  createdVisible?: number;
  updated?: number;
  rejected?: number;
  error?: string;
}

type RunKind = "collect" | "pause" | "skipped";

/** The job fires hourly: night hours only log a pause, not a collection. */
const runKind = (run: CollectionRun): RunKind => {
  if (run.logs.some((entry) => /Night pause/i.test(entry.message)))
    return "pause";
  if (
    run.logs.length > 0 &&
    !run.logs.some((entry) => sourceOutcome(entry)) &&
    run.logs.some((entry) => /already running|skipped/i.test(entry.message))
  )
    return "skipped";
  return "collect";
};

const sourceOutcome = (entry: CollectionRunLogEntry): SourceOutcome | null => {
  const data = entry.data as Record<string, unknown> | undefined;
  if (!data || typeof data.sourceId !== "string") return null;
  return data as unknown as SourceOutcome;
};

const outcomesOf = (run: CollectionRun) =>
  run.logs
    .map(sourceOutcome)
    .filter((outcome): outcome is SourceOutcome => outcome !== null);

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  ok: { label: "Terminée", color: "teal" },
  error: { label: "Échec", color: "red" },
  completed: { label: "Terminée", color: "teal" },
  success: { label: "Terminée", color: "teal" },
  failed: { label: "Échec", color: "red" },
  running: { label: "En cours", color: "blue" },
  pending: { label: "En attente", color: "gray" },
};

const runStatus = (run: CollectionRun) => {
  const kind = runKind(run);
  if (kind === "pause") return { label: "Pause de nuit", color: "gray" };
  if (kind === "skipped")
    return { label: "Ignorée (déjà en cours)", color: "gray" };
  const base = RUN_STATUS[run.status] ?? {
    label: f.titleize(run.status),
    color: "gray",
  };
  const failures = outcomesOf(run).filter((o) => o.error).length;
  return base.color === "teal" && failures > 0
    ? {
        label: `Terminée · ${failures} erreur${failures > 1 ? "s" : ""}`,
        color: "orange",
      }
    : base;
};

const LOG_LEVEL: Record<string, string> = {
  ERROR: "red",
  WARN: "orange",
  INFO: "blue",
  DEBUG: "gray",
  TRACE: "gray",
};

const time = (value: string | Date) =>
  new Date(value).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });

// ── Page ────────────────────────────────────────────────────────────────

const AdminPage: FC<AdminPageProps> = ({
  stats: initialStats,
  products: initialProducts,
  runs: initialRuns,
  sources: sourceRefs,
  tab: initialTab,
}) => {
  const admin = useClient<AdminController>();
  const productsClient = useClient<ProductsController>();
  const now = useNow();

  const [tab, setTab] = useState(initialTab ?? "overview");
  const [stats, setStats] = useState(initialStats);
  const [products, setProducts] = useState(initialProducts);
  const [runs, setRuns] = useState(initialRuns);
  const [starting, setStarting] = useState(false);

  /** Reloads everything once a run has finished. */
  const refresh = async () => {
    const [nextStats, nextProducts, nextRuns] = await Promise.all([
      admin.stats({}),
      productsClient.listProducts({ query: {} }),
      admin.runs({ query: { size: 40 } }),
    ]);
    setStats(nextStats as AdminStats);
    setProducts(nextProducts as TrackedProduct[]);
    setRuns(nextRuns as CollectionRun[]);
  };

  // The progress sidebar announces the end of a run (see
  // CollectionProgressAside): refresh the figures then.
  useEffect(() => {
    const onFinished = () => void refresh().catch(() => undefined);
    window.addEventListener(COLLECTION_FINISHED_EVENT, onFinished);
    return () =>
      window.removeEventListener(COLLECTION_FINISHED_EVENT, onFinished);
  });

  // Keep the tab in the URL so a reload or a shared link lands on it.
  const changeTab = (value: string | null) => {
    const next = value ?? "overview";
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  };

  /**
   * Starts a run and hands over to the progress sidebar: a run takes many
   * minutes, far too long for a spinner in a toast.
   */
  const collectNow = async () => {
    setStarting(true);
    try {
      const { started, message } = await admin.collectNow({});
      notifications.show({
        color: started ? "teal" : "orange",
        icon: <Icon name={started ? "check" : "alert"} size={16} />,
        title: message,
        message: "Suivez l'avancement dans le panneau de droite.",
        autoClose: 5000,
      });
      window.dispatchEvent(new Event(COLLECTION_STARTED_EVENT));
    } catch {
      notifications.show({
        color: "red",
        icon: <Icon name="alert" size={16} />,
        title: "Impossible de lancer la collecte",
        message: "Consultez l'onglet Journaux pour le détail.",
        autoClose: 8000,
      });
    } finally {
      setStarting(false);
    }
  };

  const collections = runs.filter((run) => runKind(run) === "collect");
  const lastRun = collections[0];
  const failing = stats.sources.filter((s) => healthOf(s) === "error");
  const inService = stats.sources.filter((s) => healthOf(s) === "ok");

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <Stack gap={2}>
          <Title order={1} fz="1.75rem">
            Administration
          </Title>
          <Text fz="sm" c="dimmed">
            Les sources qui alimentent DealRadar, leurs collectes et les
            produits que vous suivez à la main.
          </Text>
        </Stack>
        <Button
          loading={starting}
          disabled={stats.running}
          onClick={() => void collectNow()}
          leftSection={<Icon name="play" size={15} />}
        >
          {stats.running ? "Collecte en cours…" : "Lancer une collecte"}
        </Button>
      </Group>

      <HealthBanner
        stats={stats}
        failing={failing}
        lastRun={lastRun}
        now={now}
        onShowSources={() => changeTab("sources")}
      />

      <Tabs value={tab} onChange={changeTab} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab
            value="overview"
            leftSection={<Icon name="dashboard" size={14} />}
          >
            Vue d'ensemble
          </Tabs.Tab>
          <Tabs.Tab
            value="sources"
            leftSection={<Icon name="store" size={14} />}
          >
            Sources
            {failing.length > 0 ? (
              <Badge size="xs" color="red" variant="filled" ml={6}>
                {failing.length}
              </Badge>
            ) : null}
          </Tabs.Tab>
          <Tabs.Tab
            value="products"
            leftSection={<Icon name="package" size={14} />}
          >
            Produits suivis
            <Badge size="xs" variant="light" ml={6}>
              {products.length}
            </Badge>
          </Tabs.Tab>
          <Tabs.Tab value="logs" leftSection={<Icon name="clock" size={14} />}>
            Journaux
          </Tabs.Tab>
        </Tabs.List>

        <Tabs.Panel value="overview">
          <Overview
            stats={stats}
            inService={inService.length}
            collections={collections}
            now={now}
            onShowSources={() => changeTab("sources")}
            onShowLogs={() => changeTab("logs")}
          />
        </Tabs.Panel>

        <Tabs.Panel value="sources">
          <SourcesTab sources={stats.sources} now={now} />
        </Tabs.Panel>

        <Tabs.Panel value="products">
          <ProductsTab
            products={products}
            setProducts={setProducts}
            sourceRefs={sourceRefs}
            onPriceSaved={async () =>
              setStats((await admin.stats({})) as AdminStats)
            }
            client={productsClient}
          />
        </Tabs.Panel>

        <Tabs.Panel value="logs">
          <LogsTab runs={runs} sources={stats.sources} />
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
};

// ── Health banner ───────────────────────────────────────────────────────

const HealthBanner: FC<{
  stats: AdminStats;
  failing: AdminSource[];
  lastRun?: CollectionRun;
  now: number;
  onShowSources: () => void;
}> = ({ stats, failing, lastRun, now, onShowSources }) => {
  const lastFailed =
    lastRun?.status === "failed" || lastRun?.status === "error";
  const tone = stats.running
    ? { color: "blue", icon: "refresh" as IconName }
    : failing.length > 0 || lastFailed
      ? { color: "orange", icon: "alert" as IconName }
      : { color: "teal", icon: "check" as IconName };

  const headline = stats.running
    ? "Collecte en cours"
    : lastFailed
      ? "La dernière collecte a échoué"
      : failing.length > 0
        ? `${failing.length} source${failing.length > 1 ? "s" : ""} en erreur`
        : "Tout fonctionne";

  const parts: string[] = [];
  if (lastRun?.startedAt && now) {
    parts.push(
      `dernière collecte ${f.relativeTime(lastRun.startedAt, now) ?? ""} (${f.duration(lastRun.durationMs)})`,
    );
  }
  parts.push(`prochaine à ${time(stats.nextRunAt)}`);

  return (
    <Paper
      p="md"
      style={{
        borderLeft: `4px solid var(--mantine-color-${tone.color}-6)`,
      }}
    >
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Group gap="md" wrap="nowrap">
          <ThemeIcon variant="light" color={tone.color} size={38} radius="xl">
            <Icon name={tone.icon} size={20} />
          </ThemeIcon>
          <Stack gap={0}>
            <Text fw={700}>{headline}</Text>
            <Text fz="sm" c="dimmed">
              {failing.length > 0
                ? `${failing.map((s) => s.name.split(" (")[0]).join(", ")} — ${parts.join(", ")}`
                : parts.join(", ").replace(/^./, (c) => c.toUpperCase())}
            </Text>
          </Stack>
        </Group>
        {failing.length > 0 ? (
          <Button
            variant="light"
            color="orange"
            size="xs"
            onClick={onShowSources}
          >
            Voir les sources
          </Button>
        ) : null}
      </Group>
    </Paper>
  );
};

// ── Vue d'ensemble ──────────────────────────────────────────────────────

const Overview: FC<{
  stats: AdminStats;
  inService: number;
  collections: CollectionRun[];
  now: number;
  onShowSources: () => void;
  onShowLogs: () => void;
}> = ({ stats, inService, collections, now, onShowSources, onShowLogs }) => {
  const scheduled = stats.sources.filter((s) => s.enabled && s.scheduled);
  const families = FAMILIES.map((family) => {
    const members = stats.sources.filter((s) => family.ids.includes(s.id));
    return {
      ...family,
      members,
      visible: members.reduce((sum, s) => sum + s.visibleDeals, 0),
    };
  }).filter((family) => family.members.length > 0);
  const maxVisible = Math.max(1, ...families.map((family) => family.visible));
  const lastCollected = (
    collections[0] ? outcomesOf(collections[0]) : []
  ).reduce((sum, o) => sum + (o.collected ?? 0), 0);

  return (
    <Stack gap="xl">
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile
          label="Offres visibles"
          value={stats.visibleDeals}
          hint={`sur ${stats.activeDeals} actives · ${stats.expiredDeals} expirées`}
          icon="eye"
        />
        <StatTile
          label="Brouillons à relire"
          value={stats.draftsPending}
          hint="prêts pour Dealabs"
          icon="inbox"
        />
        <StatTile
          label="Sources en service"
          value={`${inService} / ${stats.sources.length}`}
          hint={`${scheduled.filter((s) => s.everyHours > 1).length} ralenties par l'agent`}
          icon="store"
        />
        <StatTile
          label="Dernière collecte"
          value={lastCollected ? f.compactNumber(lastCollected) : "—"}
          hint="offres lues par les sources"
          icon="refresh"
        />
      </SimpleGrid>

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Section
            title="Où se trouvent les offres"
            description="Offres visibles (score ≥ 40) par famille de sources, et l'état de chaque source."
            action={
              <Anchor
                component="button"
                fz="sm"
                fw={600}
                onClick={onShowSources}
              >
                Détail des sources
              </Anchor>
            }
          >
            <Paper p="md">
              <Stack gap="md">
                {families.map((family) => (
                  <Stack key={family.label} gap={6}>
                    <Group justify="space-between" wrap="nowrap">
                      <Group gap={8} wrap="nowrap">
                        <Icon
                          name={family.icon}
                          size={15}
                          color="var(--mantine-color-dimmed)"
                        />
                        <Text fw={600} fz="sm">
                          {family.label}
                        </Text>
                      </Group>
                      <Text fz="sm" className="tnum">
                        {family.visible} offre{family.visible > 1 ? "s" : ""}
                      </Text>
                    </Group>
                    <Progress
                      value={(family.visible / maxVisible) * 100}
                      color="blue"
                      size="sm"
                    />
                    <Group gap={10}>
                      {family.members.map((source) => {
                        const health = HEALTH[healthOf(source)];
                        return (
                          <Tooltip
                            key={source.id}
                            label={`${health.label} · ${source.visibleDeals} visibles · ${frequency(source)}`}
                            withArrow
                          >
                            <Group gap={5} wrap="nowrap">
                              <Dot color={health.color} />
                              <Text fz="xs" c="dimmed">
                                {source.id}
                              </Text>
                            </Group>
                          </Tooltip>
                        );
                      })}
                    </Group>
                  </Stack>
                ))}
              </Stack>
            </Paper>
          </Section>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 5 }}>
          <Section
            title="Dernières collectes"
            description="Les pauses de nuit sont masquées."
            action={
              <Anchor component="button" fz="sm" fw={600} onClick={onShowLogs}>
                Journaux
              </Anchor>
            }
          >
            {collections.length === 0 ? (
              <EmptyState
                icon="clock"
                title="Aucune collecte enregistrée"
                description="Lancez-en une pour vérifier les sources."
              />
            ) : (
              <Paper p="md">
                <Stack gap="sm">
                  {collections.slice(0, 7).map((run) => {
                    const status = runStatus(run);
                    const outcomes = outcomesOf(run);
                    const collected = outcomes.reduce(
                      (sum, o) => sum + (o.collected ?? 0),
                      0,
                    );
                    const created = outcomes.reduce(
                      (sum, o) => sum + (o.created ?? 0),
                      0,
                    );
                    return (
                      <Group
                        key={run.id}
                        justify="space-between"
                        wrap="nowrap"
                        gap="sm"
                      >
                        <Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
                          <Dot color={status.color} size={10} />
                          <Stack gap={0} style={{ minWidth: 0 }}>
                            <Text fz="sm" fw={600}>
                              {run.startedAt
                                ? `${f.dayShort(run.startedAt)} · ${time(run.startedAt)}`
                                : "—"}
                            </Text>
                            <Text fz="xs" c="dimmed" truncate>
                              {outcomes.length > 0
                                ? `${outcomes.length} sources · ${collected} offres lues · ${created} nouvelles`
                                : status.label}
                            </Text>
                          </Stack>
                        </Group>
                        <Text
                          fz="xs"
                          c="dimmed"
                          className="tnum"
                          style={{ whiteSpace: "nowrap" }}
                        >
                          {f.duration(run.durationMs)}
                        </Text>
                      </Group>
                    );
                  })}
                </Stack>
              </Paper>
            )}
          </Section>
          <Text fz="xs" c="dimmed" mt="sm">
            {now
              ? `${f.compactNumber(stats.priceObservations)} relevés de prix en base · ${stats.trackedProducts} produits suivis.`
              : null}
          </Text>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

// ── Sources ─────────────────────────────────────────────────────────────

const SourcesTab: FC<{ sources: AdminSource[]; now: number }> = ({
  sources,
  now,
}) => {
  const [filter, setFilter] = useState("all");
  const [open, setOpen] = useState<string | null>(null);

  const counts = {
    error: sources.filter((s) => healthOf(s) === "error").length,
    slowed: sources.filter((s) => s.scheduled && s.everyHours > 1).length,
    paused: sources.filter((s) => ["paused", "off"].includes(healthOf(s)))
      .length,
  };
  const shown = sources.filter((source) => {
    const health = healthOf(source);
    if (filter === "error") return health === "error";
    if (filter === "slowed") return source.scheduled && source.everyHours > 1;
    if (filter === "paused") return health === "paused" || health === "off";
    return true;
  });
  const groups = [...FAMILIES.map((family) => family.label), "Autres"]
    .map((label) => ({
      label,
      members: shown.filter((s) => familyOf(s.id) === label),
    }))
    .filter((group) => group.members.length > 0);
  const maxVisible = Math.max(1, ...sources.map((s) => s.visibleDeals));

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={setFilter}
          data={[
            { value: "all", label: `Toutes (${sources.length})` },
            { value: "error", label: `En erreur (${counts.error})` },
            { value: "slowed", label: `Ralenties (${counts.slowed})` },
            { value: "paused", label: `Coupées (${counts.paused})` },
          ]}
        />
        <Text fz="xs" c="dimmed">
          La fréquence est réglée chaque jour par l'agent Sources · 🔒 = jamais
          coupée
        </Text>
      </Group>

      {groups.length === 0 ? (
        <EmptyState
          icon="check"
          title="Rien à signaler"
          description="Aucune source dans ce filtre."
        />
      ) : (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={760}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>État</Table.Th>
                  <Table.Th>Fréquence</Table.Th>
                  <Table.Th w={190}>Offres visibles</Table.Th>
                  <Table.Th>Dernier succès</Table.Th>
                  <Table.Th>Durée</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {groups.map((group) => (
                  <SourceGroup
                    key={group.label}
                    label={group.label}
                    members={group.members}
                    maxVisible={maxVisible}
                    open={open}
                    setOpen={setOpen}
                    now={now}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}
    </Stack>
  );
};

const SourceGroup: FC<{
  label: string;
  members: AdminSource[];
  maxVisible: number;
  open: string | null;
  setOpen: (id: string | null) => void;
  now: number;
}> = ({ label, members, maxVisible, open, setOpen, now }) => (
  <>
    <Table.Tr>
      <Table.Td colSpan={6} py={6} bg="var(--mantine-color-default-hover)">
        <Text
          fz="xs"
          fw={700}
          tt="uppercase"
          c="dimmed"
          style={{ letterSpacing: 0.5 }}
        >
          {label}
        </Text>
      </Table.Td>
    </Table.Tr>
    {members.map((source) => {
      const health = HEALTH[healthOf(source)];
      const isOpen = open === source.id;
      return (
        <SourceRow
          key={source.id}
          source={source}
          health={health}
          isOpen={isOpen}
          onToggle={() => setOpen(isOpen ? null : source.id)}
          maxVisible={maxVisible}
          now={now}
        />
      );
    })}
  </>
);

const SourceRow: FC<{
  source: AdminSource;
  health: { label: string; color: string };
  isOpen: boolean;
  onToggle: () => void;
  maxVisible: number;
  now: number;
}> = ({ source, health, isOpen, onToggle, maxVisible, now }) => (
  <>
    <Table.Tr onClick={onToggle} style={{ cursor: "pointer" }}>
      <Table.Td>
        <Group gap={8} wrap="nowrap">
          <Icon
            name={isOpen ? "chevronDown" : "chevronRight"}
            size={14}
            color="var(--mantine-color-dimmed)"
          />
          <Stack gap={0}>
            <Text fz="sm" fw={600}>
              {source.locked ? "🔒 " : ""}
              {source.name.split(" (")[0]}
            </Text>
            <Text fz="xs" c="dimmed">
              {source.name.includes("(")
                ? source.name.slice(source.name.indexOf("(") + 1, -1)
                : source.id}
            </Text>
          </Stack>
        </Group>
      </Table.Td>
      <Table.Td>
        <Badge
          variant="light"
          color={health.color}
          leftSection={<Dot color={health.color} size={6} />}
        >
          {health.label}
        </Badge>
      </Table.Td>
      <Table.Td fz="sm" c={source.everyHours > 1 ? "blue" : undefined}>
        {frequency(source)}
      </Table.Td>
      <Table.Td>
        <Group gap={8} wrap="nowrap">
          <Progress
            value={(source.visibleDeals / maxVisible) * 100}
            size="sm"
            color="blue"
            w={90}
          />
          <Text fz="sm" className="tnum">
            {source.visibleDeals}
          </Text>
          <Text fz="xs" c="dimmed" className="tnum">
            / {source.activeDeals}
          </Text>
        </Group>
      </Table.Td>
      <Table.Td fz="sm" c="dimmed">
        {now && source.lastSuccessAt
          ? (f.relativeTime(source.lastSuccessAt, now) ?? "—")
          : "—"}
      </Table.Td>
      <Table.Td fz="sm" c="dimmed" className="tnum">
        {source.lastDurationMs !== undefined
          ? f.duration(source.lastDurationMs)
          : "—"}
      </Table.Td>
    </Table.Tr>
    {isOpen ? (
      <Table.Tr>
        <Table.Td colSpan={6} bg="var(--mantine-color-default-hover)">
          <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm" py={4} px="md">
            <Detail label="Identifiant" value={<Code>{source.id}</Code>} />
            <Detail
              label="Type"
              value={
                source.type === "api"
                  ? "API officielle"
                  : source.type === "scrape"
                    ? "Lecture de pages"
                    : "Manuelle"
              }
            />
            <Detail
              label="Dernier passage"
              value={source.lastRunAt ? f.dateTime(source.lastRunAt) : "jamais"}
            />
            <Detail
              label="Dernière collecte"
              value={
                source.lastCollected !== undefined
                  ? `${source.lastCollected} lues · ${source.lastNewVisible ?? 0} nouvelles visibles`
                  : "pas encore mesurée"
              }
            />
          </SimpleGrid>
          {source.lastError ? (
            <Paper
              p="sm"
              mx="md"
              mt="xs"
              withBorder
              style={{ borderColor: "var(--mantine-color-red-6)" }}
            >
              <Text fz="xs" fw={700} c="red" mb={2}>
                Dernière erreur
                {source.lastErrorAt
                  ? ` · ${f.dateTime(source.lastErrorAt)}`
                  : ""}
              </Text>
              <Text
                fz="xs"
                ff="monospace"
                style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}
              >
                {source.lastError}
              </Text>
            </Paper>
          ) : null}
        </Table.Td>
      </Table.Tr>
    ) : null}
  </>
);

const Detail: FC<{ label: string; value: ReactNode }> = ({ label, value }) => (
  <Stack gap={0}>
    <Text fz="xs" c="dimmed">
      {label}
    </Text>
    <Text fz="sm" component="div">
      {value}
    </Text>
  </Stack>
);

// ── Produits suivis ─────────────────────────────────────────────────────

const EMPTY_FORM = {
  sourceId: "manual",
  title: "",
  url: "",
  manualPrice: "",
  steamAppId: "",
  idealoUrl: "",
};

const ProductsTab: FC<{
  products: TrackedProduct[];
  setProducts: (products: TrackedProduct[]) => void;
  sourceRefs: RefItem[];
  onPriceSaved: () => Promise<void>;
  client: ReturnType<typeof useClient<ProductsController>>;
}> = ({ products, setProducts, sourceRefs, onPriceSaved, client }) => {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [search, setSearch] = useState("");

  const sourceOptions = useMemo(
    () =>
      sourceRefs.map((source) => ({
        value: source.id,
        label: source.name ?? source.id,
      })),
    [sourceRefs],
  );
  const shown = products.filter((product) =>
    `${product.title} ${product.sourceId}`
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const addProduct = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const created = await client.create({
        body: {
          sourceId: form.sourceId,
          title: form.title,
          url: form.url,
          manualPrice: form.manualPrice ? Number(form.manualPrice) : undefined,
          steamAppId: form.steamAppId ? Number(form.steamAppId) : undefined,
          idealoUrl: form.idealoUrl || undefined,
        },
      });
      setProducts([...products, created as TrackedProduct]);
      setForm(EMPTY_FORM);
      setAdding(false);
      notifications.show({
        message: "Produit ajouté au suivi",
        color: "teal",
        icon: <Icon name="check" size={16} />,
      });
    } catch {
      notifications.show({
        title: "Ajout impossible",
        message: "Vérifiez l'URL et la source choisie.",
        color: "red",
      });
    }
  };

  const updateManualPrice = async (id: string, value: string) => {
    if (!value) return;
    const updated = await client.updateManualPrice({
      params: { id },
      body: { manualPrice: Number(value) },
    });
    setProducts(
      products.map((product) =>
        product.id === id ? (updated as TrackedProduct) : product,
      ),
    );
    await onPriceSaved();
    notifications.show({
      message: "Prix enregistré, collecte relancée pour cette source",
      color: "teal",
    });
  };

  const updateIdealoUrl = async (id: string, value: string) => {
    const updated = await client.updateIdealoUrl({
      params: { id },
      body: { idealoUrl: value || undefined },
    });
    setProducts(
      products.map((product) =>
        product.id === id ? (updated as TrackedProduct) : product,
      ),
    );
    notifications.show({
      message: "Référence Idealo enregistrée",
      color: "teal",
    });
  };

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Text fz="sm" c="dimmed" maw={560}>
          Des produits surveillés un par un, en plus des offres découvertes
          automatiquement : leur prix est suivi dans la durée, même quand aucune
          promotion ne les affiche.
        </Text>
        <Group gap="sm">
          {products.length > 6 ? (
            <TextInput
              size="xs"
              placeholder="Rechercher…"
              leftSection={<Icon name="search" size={14} />}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          ) : null}
          <Button
            size="xs"
            leftSection={<Icon name="package" size={14} />}
            onClick={() => setAdding(true)}
          >
            Ajouter un produit
          </Button>
        </Group>
      </Group>

      {products.length === 0 ? (
        <EmptyState
          icon="package"
          title="Aucun produit suivi"
          description="Ajoutez l'URL d'un produit pour suivre son prix, même s'il n'apparaît dans aucune offre."
        />
      ) : (
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={640}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Produit</Table.Th>
                  <Table.Th>Source</Table.Th>
                  <Table.Th w={170}>Prix relevé (manuel)</Table.Th>
                  <Table.Th w={260}>Référence Idealo</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {shown.map((product) => (
                  <Table.Tr key={product.id}>
                    <Table.Td>
                      <Anchor
                        href={product.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        fz="sm"
                        fw={600}
                        c="var(--mantine-color-text)"
                        lineClamp={1}
                        maw={320}
                      >
                        {product.title}
                      </Anchor>
                    </Table.Td>
                    <Table.Td>
                      <Badge variant="default" size="sm">
                        {product.sourceId}
                      </Badge>
                    </Table.Td>
                    <Table.Td>
                      {product.sourceId === "manual" ? (
                        <ManualPriceField
                          defaultValue={product.manualPrice}
                          onSubmit={(value) =>
                            void updateManualPrice(product.id, value)
                          }
                        />
                      ) : (
                        <Text fz="xs" c="dimmed">
                          relevé automatiquement
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <IdealoUrlField
                        defaultValue={product.idealoUrl}
                        referencePrice={product.idealoReferencePrice}
                        onSubmit={(value) =>
                          void updateIdealoUrl(product.id, value)
                        }
                      />
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      )}

      <Modal
        opened={adding}
        onClose={() => setAdding(false)}
        title="Suivre un produit"
        centered
        size="lg"
      >
        <form onSubmit={addProduct}>
          <Stack gap="sm">
            <TextInput
              label="Nom du produit"
              placeholder="ex. Lenovo IdeaPad Slim 3 16 Go / 512 Go"
              required
              value={form.title}
              onChange={(event) =>
                setForm({ ...form, title: event.currentTarget.value })
              }
            />
            <TextInput
              label="Adresse de la page produit"
              required
              type="url"
              placeholder="https://…"
              value={form.url}
              onChange={(event) =>
                setForm({ ...form, url: event.currentTarget.value })
              }
            />
            <Select
              label="Source"
              description="Qui relève le prix : vous (manuel), Steam par son API, ou la boutique."
              data={sourceOptions}
              searchable
              allowDeselect={false}
              value={form.sourceId}
              onChange={(value) =>
                setForm({ ...form, sourceId: value ?? "manual" })
              }
            />
            {form.sourceId === "manual" ? (
              <NumberInput
                label="Prix relevé"
                suffix=" €"
                min={0}
                decimalScale={2}
                value={form.manualPrice}
                onChange={(value) =>
                  setForm({ ...form, manualPrice: String(value ?? "") })
                }
              />
            ) : null}
            {form.sourceId === "steam" ? (
              <NumberInput
                label="App ID Steam"
                description="Le nombre dans l'adresse store.steampowered.com/app/…"
                min={0}
                value={form.steamAppId}
                onChange={(value) =>
                  setForm({ ...form, steamAppId: String(value ?? "") })
                }
              />
            ) : null}
            <TextInput
              label="Page Idealo (optionnel)"
              description="Donne un prix de référence du marché au score."
              type="url"
              placeholder="https://www.idealo.fr/prix/…"
              value={form.idealoUrl}
              onChange={(event) =>
                setForm({ ...form, idealoUrl: event.currentTarget.value })
              }
            />
            <Group justify="flex-end" mt="sm">
              <Button variant="default" onClick={() => setAdding(false)}>
                Annuler
              </Button>
              <Button type="submit">Ajouter au suivi</Button>
            </Group>
          </Stack>
        </form>
      </Modal>
    </Stack>
  );
};

/**
 * Price entry that only commits on blur or Enter.
 *
 * Saving on every keystroke would re-run the collector for the source on
 * each digit typed — the one action on this page with a real cost.
 */
const ManualPriceField: FC<{
  defaultValue?: number;
  onSubmit: (value: string) => void;
}> = ({ defaultValue, onSubmit }) => {
  const [value, setValue] = useState(
    defaultValue === undefined ? "" : String(defaultValue),
  );

  return (
    <NumberInput
      size="xs"
      suffix=" €"
      min={0}
      decimalScale={2}
      placeholder="—"
      value={value}
      onChange={(next) => setValue(String(next ?? ""))}
      onBlur={() => value !== String(defaultValue ?? "") && onSubmit(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(value);
        }
      }}
      aria-label="Prix relevé manuellement"
    />
  );
};

/**
 * Idealo page URL entry that only commits on blur or Enter, same rationale
 * as {@link ManualPriceField}. Shows the last cached reference price (if
 * any) as a hint — the fetch itself only happens on the next collection
 * run, not from this form.
 */
const IdealoUrlField: FC<{
  defaultValue?: string;
  referencePrice?: number;
  onSubmit: (value: string) => void;
}> = ({ defaultValue, referencePrice, onSubmit }) => {
  const [value, setValue] = useState(defaultValue ?? "");

  return (
    <Stack gap={2}>
      <TextInput
        size="xs"
        type="url"
        placeholder="https://www.idealo.fr/prix/…"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={() => value !== (defaultValue ?? "") && onSubmit(value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit(value);
          }
        }}
        aria-label="Page Idealo de référence"
      />
      {referencePrice !== undefined ? (
        <Text c="dimmed" fz="xs">
          Référence marché : {f.price(referencePrice)}
        </Text>
      ) : null}
    </Stack>
  );
};

// ── Journaux ────────────────────────────────────────────────────────────

const LogsTab: FC<{ runs: CollectionRun[]; sources: AdminSource[] }> = ({
  runs,
  sources,
}) => {
  const [filter, setFilter] = useState("collect");
  // Short names ("Amazon"), except where two sources would share one.
  const short = (s: AdminSource) => s.name.split(" (")[0];
  const names = new Map(
    sources.map((s) => [
      s.id,
      sources.filter((o) => short(o) === short(s)).length > 1
        ? s.name
        : short(s),
    ]),
  );

  const shown = runs.filter((run) => {
    const kind = runKind(run);
    if (filter === "collect") return kind === "collect";
    if (filter === "errors")
      return (
        kind === "collect" &&
        (run.status === "failed" ||
          run.status === "error" ||
          outcomesOf(run).some((o) => o.error))
      );
    return true;
  });

  return (
    <Stack gap="md">
      <Group justify="space-between" wrap="wrap" gap="sm">
        <SegmentedControl
          size="xs"
          value={filter}
          onChange={setFilter}
          data={[
            { value: "collect", label: "Collectes" },
            { value: "errors", label: "Avec erreurs" },
            { value: "all", label: "Tout (pauses de nuit comprises)" },
          ]}
        />
        <Text fz="xs" c="dimmed">
          {runs.length} dernières exécutions du job « deals.collect »
        </Text>
      </Group>

      {shown.length === 0 ? (
        <EmptyState
          icon="check"
          title="Rien ici"
          description="Aucune exécution dans ce filtre."
        />
      ) : (
        <Accordion variant="separated" chevronPosition="left">
          {shown.map((run) => {
            const status = runStatus(run);
            const outcomes = outcomesOf(run).sort(
              (a, b) =>
                Number(!!b.error) - Number(!!a.error) ||
                (b.collected ?? 0) - (a.collected ?? 0),
            );
            const others = run.logs.filter((entry) => !sourceOutcome(entry));
            const collected = outcomes.reduce(
              (sum, o) => sum + (o.collected ?? 0),
              0,
            );
            const created = outcomes.reduce(
              (sum, o) => sum + (o.created ?? 0),
              0,
            );
            return (
              <Accordion.Item key={run.id} value={run.id}>
                <Accordion.Control>
                  <Group justify="space-between" wrap="wrap" gap="xs" pr="sm">
                    <Group gap="sm" wrap="nowrap">
                      <Dot color={status.color} size={10} />
                      <Text fw={600} fz="sm">
                        {run.startedAt ? f.dateTime(run.startedAt) : "—"}
                      </Text>
                      <Badge variant="light" color={status.color} size="sm">
                        {status.label}
                      </Badge>
                    </Group>
                    <Text fz="xs" c="dimmed" className="tnum">
                      {outcomes.length > 0
                        ? `${outcomes.length} sources · ${collected} offres lues · ${created} nouvelles · `
                        : ""}
                      {f.duration(run.durationMs)}
                      {run.triggeredBy ? ` · ${run.triggeredBy}` : ""}
                    </Text>
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="md">
                    {run.error ? (
                      <Paper
                        p="sm"
                        withBorder
                        style={{ borderColor: "var(--mantine-color-red-6)" }}
                      >
                        <Text
                          fz="xs"
                          ff="monospace"
                          c="red"
                          style={{ whiteSpace: "pre-wrap" }}
                        >
                          {run.error}
                        </Text>
                      </Paper>
                    ) : null}
                    {outcomes.length > 0 ? (
                      <Table.ScrollContainer minWidth={560}>
                        <Table verticalSpacing={6} fz="sm">
                          <Table.Thead>
                            <Table.Tr>
                              <Table.Th>Source</Table.Th>
                              <Table.Th ta="right">Lues</Table.Th>
                              <Table.Th ta="right">Nouvelles</Table.Th>
                              <Table.Th ta="right">Mises à jour</Table.Th>
                              <Table.Th ta="right">Écartées</Table.Th>
                              <Table.Th>Résultat</Table.Th>
                            </Table.Tr>
                          </Table.Thead>
                          <Table.Tbody>
                            {outcomes.map((o) => (
                              <Table.Tr key={o.sourceId}>
                                <Table.Td fw={500}>
                                  {names.get(o.sourceId) ?? o.sourceId}
                                </Table.Td>
                                <Table.Td ta="right" className="tnum">
                                  {o.collected ?? "—"}
                                </Table.Td>
                                <Table.Td ta="right" className="tnum">
                                  {o.created ?? "—"}
                                  {o.createdVisible ? (
                                    <Text span c="dimmed" fz="xs">
                                      {" "}
                                      ({o.createdVisible} visibles)
                                    </Text>
                                  ) : null}
                                </Table.Td>
                                <Table.Td ta="right" className="tnum">
                                  {o.updated ?? "—"}
                                </Table.Td>
                                <Table.Td ta="right" className="tnum">
                                  {o.rejected ?? "—"}
                                </Table.Td>
                                <Table.Td>
                                  {o.error ? (
                                    <Tooltip
                                      label={o.error}
                                      multiline
                                      w={340}
                                      withArrow
                                    >
                                      <Text
                                        fz="xs"
                                        c="red"
                                        lineClamp={1}
                                        maw={240}
                                      >
                                        {o.error}
                                      </Text>
                                    </Tooltip>
                                  ) : (
                                    <Text fz="xs" c="teal">
                                      OK
                                    </Text>
                                  )}
                                </Table.Td>
                              </Table.Tr>
                            ))}
                          </Table.Tbody>
                        </Table>
                      </Table.ScrollContainer>
                    ) : null}
                    {others.length > 0 ? <RawLog entries={others} /> : null}
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            );
          })}
        </Accordion>
      )}
    </Stack>
  );
};

/**
 * The job's other log lines, folded by default: a few of them carry whole
 * JSON payloads, which used to bury the page. Long lines are cut, full
 * text on demand.
 */
const RawLog: FC<{ entries: CollectionRunLogEntry[] }> = ({ entries }) => {
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState<number | null>(null);
  const warnings = entries.filter(
    (e) => e.level === "WARN" || e.level === "ERROR",
  ).length;

  return (
    <Stack gap={6}>
      <Group gap="sm">
        <Button
          variant="subtle"
          color="gray"
          size="compact-xs"
          leftSection={
            <Icon name={open ? "chevronDown" : "chevronRight"} size={12} />
          }
          onClick={() => setOpen(!open)}
        >
          Journal brut · {entries.length} ligne{entries.length > 1 ? "s" : ""}
        </Button>
        {warnings > 0 ? (
          <Badge size="xs" color="orange" variant="light">
            {warnings} avertissement{warnings > 1 ? "s" : ""}
          </Badge>
        ) : null}
      </Group>
      {open ? (
        <Paper p="xs" bg="var(--mantine-color-default-hover)">
          {entries.map((entry, index) => {
            const long = entry.message.length > 220;
            const expanded = full === index;
            return (
              <Group
                key={index}
                gap="sm"
                wrap="nowrap"
                align="flex-start"
                py={2}
              >
                <Text
                  fz="xs"
                  c="dimmed"
                  ff="monospace"
                  style={{ flexShrink: 0 }}
                >
                  {time(new Date(entry.timestamp))}
                </Text>
                <Text
                  fz="xs"
                  ff="monospace"
                  fw={700}
                  c={LOG_LEVEL[entry.level] ?? "gray"}
                  w={44}
                  style={{ flexShrink: 0 }}
                >
                  {entry.level}
                </Text>
                <Text
                  fz="xs"
                  ff="monospace"
                  style={{ wordBreak: "break-word", minWidth: 0 }}
                >
                  {long && !expanded
                    ? `${entry.message.slice(0, 220)}…`
                    : entry.message}
                  {long ? (
                    <Anchor
                      component="button"
                      fz="xs"
                      ml={6}
                      onClick={() => setFull(expanded ? null : index)}
                    >
                      {expanded ? "réduire" : "tout afficher"}
                    </Anchor>
                  ) : null}
                </Text>
              </Group>
            );
          })}
        </Paper>
      ) : null}
    </Stack>
  );
};

export default AdminPage;
