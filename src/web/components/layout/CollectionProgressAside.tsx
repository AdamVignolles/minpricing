import {
  ActionIcon,
  Anchor,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Loader,
  Progress,
  ScrollArea,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
  Title,
  Tooltip,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, useEffect, useState } from "react";

import type { AdminController } from "../../../api/controllers/AdminController.ts";
import type { CollectionProgress } from "../../types.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";

/** Fired by the "Lancer une collecte" button: poll right away. */
export const COLLECTION_STARTED_EVENT = "dealradar:collection-started";
/** Fired here when a run ends, so pages can reload their figures. */
export const COLLECTION_FINISHED_EVENT = "dealradar:collection-finished";

type Progress = CollectionProgress;
type SourceProgress = Progress["sources"][number];

const POLL_RUNNING_MS = 2_000;
const POLL_IDLE_MS = 20_000;
/** A finished run stays on screen this long (unless closed). */
const SHOW_AFTER_FINISH_MS = 10 * 60 * 1000;
/** Not a marketplace: the publishing step that ends a run. */
const PUBLISH_STEP = "dealabs-publish";

const STATUS: Record<
  SourceProgress["status"],
  { label: string; color: string }
> = {
  pending: { label: "En attente", color: "gray" },
  running: { label: "En cours", color: "blue" },
  done: { label: "Terminé", color: "teal" },
  failed: { label: "Échec", color: "red" },
};

const time = (iso: string, withSeconds = false) =>
  new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });

/**
 * Polls the collection progress. Exposed as a hook so the layout can both
 * render the sidebar and decide whether the AppShell aside is open: on its
 * own while a run is going (and for a while after), or whenever the user
 * opens it from the header.
 */
export function useCollectionProgress() {
  const admin = useClient<AdminController>();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [nextRunAt, setNextRunAt] = useState<string | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(false);
  // Clock sampled at each poll (render must stay pure: no Date.now there).
  const [polledAt, setPolledAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previousStatus: string | undefined;

    async function poll(): Promise<void> {
      clearTimeout(timer);
      let next: Progress | null = null;
      try {
        const response = await admin.collectProgress({});
        next = response.progress as Progress | null;
        if (!cancelled) setNextRunAt(response.nextRunAt);
      } catch {
        // Not logged in (login page) or server restarting: retry later.
      }
      if (cancelled) return;
      setProgress(next);
      setPolledAt(Date.now());
      if (previousStatus === "running" && next?.status !== "running") {
        window.dispatchEvent(new Event(COLLECTION_FINISHED_EVENT));
      }
      previousStatus = next?.status;
      timer = setTimeout(
        () => void poll(),
        next?.status === "running" ? POLL_RUNNING_MS : POLL_IDLE_MS,
      );
    }

    const onStarted = () => {
      setDismissedRunId(null);
      // The run registers itself a moment after the trigger.
      setTimeout(() => void poll(), 800);
    };
    void poll();
    window.addEventListener(COLLECTION_STARTED_EVENT, onStarted);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener(COLLECTION_STARTED_EVENT, onStarted);
    };
  }, [admin]);

  const recentlyFinished =
    !!progress?.finishedAt &&
    polledAt - new Date(progress.finishedAt).getTime() < SHOW_AFTER_FINISH_MS;
  const automatic =
    !!progress &&
    progress.runId !== dismissedRunId &&
    (progress.status === "running" || recentlyFinished);

  return {
    progress,
    nextRunAt,
    polledAt,
    visible: pinned || automatic,
    running: progress?.status === "running",
    toggle: () => {
      if (pinned || automatic) {
        setPinned(false);
        setDismissedRunId(progress?.runId ?? null);
      } else {
        setPinned(true);
      }
    },
    close: () => {
      setPinned(false);
      setDismissedRunId(progress?.runId ?? null);
    },
  };
}

/**
 * Header button: always there, so the last run and the next one can be
 * checked at any time; shows live progress while a run is going.
 */
export const CollectionHeaderButton: FC<{
  progress: Progress | null;
  open: boolean;
  onClick: () => void;
}> = ({ progress, open, onClick }) => {
  const running = progress?.status === "running";
  const done =
    progress?.sources.filter(
      (s) => s.status === "done" || s.status === "failed",
    ).length ?? 0;
  return (
    <Button
      size="xs"
      variant={open ? "light" : "subtle"}
      color={running ? "blue" : "gray"}
      onClick={onClick}
      leftSection={
        running ? (
          <Loader size={12} color="blue" />
        ) : (
          <Icon name="refresh" size={14} />
        )
      }
      className="tnum"
      aria-pressed={open}
    >
      {running ? `Collecte ${done}/${progress?.sources.length}` : "Collecte"}
    </Button>
  );
};

/** One key figure of the run. */
const Figure: FC<{ label: string; value: number; color?: string }> = ({
  label,
  value,
  color,
}) => (
  <Box>
    <Text fz="lg" fw={700} lh={1.1} className="tnum" c={color}>
      {value.toLocaleString("fr-FR")}
    </Text>
    <Text fz="xs" c="dimmed">
      {label}
    </Text>
  </Box>
);

const SourceCard: FC<{ source: SourceProgress; now: number }> = ({
  source,
  now,
}) => {
  const started = source.startedAt ? new Date(source.startedAt).getTime() : 0;
  const ended = source.finishedAt ? new Date(source.finishedAt).getTime() : now;
  const percent = source.total
    ? Math.round(((source.done ?? 0) / source.total) * 100)
    : undefined;
  return (
    <Box
      p="xs"
      style={{
        borderRadius: 8,
        border: "1px solid var(--mantine-color-default-border)",
        background:
          source.status === "running" ? "var(--app-surface-muted)" : undefined,
      }}
    >
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Text fz="sm" fw={600} lineClamp={2} title={source.name}>
          {source.name}
        </Text>
        <Group gap={6} wrap="nowrap" style={{ flexShrink: 0 }}>
          {started ? (
            <Text fz="xs" c="dimmed" className="tnum">
              {f.duration(ended - started)}
            </Text>
          ) : null}
          <Badge size="xs" variant="light" color={STATUS[source.status].color}>
            {STATUS[source.status].label}
          </Badge>
        </Group>
      </Group>

      {source.status === "running" ? (
        <Stack gap={4} mt={6}>
          <Group justify="space-between" gap="xs" wrap="nowrap">
            <Text fz="xs">{source.step ?? "Démarrage"}</Text>
            {percent !== undefined ? (
              <Text fz="xs" fw={600} className="tnum">
                {percent} %
              </Text>
            ) : null}
          </Group>
          {source.total ? (
            <>
              <Progress
                value={percent ?? 0}
                size="sm"
                color="blue"
                aria-label={`${source.done ?? 0} sur ${source.total}`}
              />
              <Text fz="xs" c="dimmed" className="tnum">
                {source.done ?? 0} / {source.total}
              </Text>
            </>
          ) : (
            <Progress value={100} size="sm" color="blue" animated striped />
          )}
        </Stack>
      ) : null}

      {source.status === "done" ? (
        <Text fz="xs" c="dimmed" mt={4} className="tnum">
          {source.summary ??
            `${source.collected ?? 0} offres · ${source.created ?? 0} nouvelles · ${source.updated ?? 0} mises à jour`}
        </Text>
      ) : null}

      {source.status === "failed" && source.error ? (
        <Text fz="xs" c="red" mt={4} lineClamp={4}>
          {source.error}
        </Text>
      ) : null}

      {source.skipped || source.warnings ? (
        <Group gap={6} mt={6}>
          {source.skipped ? (
            <Badge size="xs" variant="light" color="orange">
              {source.skipped} offre(s) ignorée(s)
            </Badge>
          ) : null}
          {source.warnings ? (
            <Badge size="xs" variant="light" color="orange">
              {source.warnings} alerte(s)
            </Badge>
          ) : null}
        </Group>
      ) : null}

      {source.links?.length ? (
        <Stack gap={2} mt={6}>
          {source.links.map((link) => (
            <Anchor
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              fz="xs"
              lineClamp={1}
            >
              {link.label}
            </Anchor>
          ))}
        </Stack>
      ) : null}
    </Box>
  );
};

/**
 * What the collection is doing right now — or did last time, and when it
 * runs next: per marketplace, which step, how far, how long, what was
 * collected, what went wrong; the deals published on Dealabs; the full
 * journal. Scrolls as a whole, so nothing gets cut off.
 */
const CollectionProgressAside: FC<{
  progress: Progress | null;
  nextRunAt: string | null;
  /** When the progress was last fetched (the clock between ticks). */
  polledAt: number;
  onClose: () => void;
}> = ({ progress, nextRunAt, polledAt, onClose }) => {
  const running = progress?.status === "running";
  const [filter, setFilter] = useState<"all" | "warn">("all");
  // Live clock while running (elapsed time, durations); sampled in an
  // effect, not during render.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setTick(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);
  const now = Math.max(polledAt, tick);

  const header = (
    <Group justify="space-between" wrap="nowrap" align="flex-start">
      <Title order={2} fz="md">
        Collecte
      </Title>
      <Tooltip label="Masquer">
        <ActionIcon
          variant="subtle"
          color="gray"
          onClick={onClose}
          aria-label="Masquer le suivi de collecte"
        >
          <Icon name="close" size={16} />
        </ActionIcon>
      </Tooltip>
    </Group>
  );

  const nextRun = nextRunAt ? (
    <Group gap={6}>
      <Icon name="clock" size={14} aria-hidden />
      <Text fz="xs" c="dimmed">
        Prochaine collecte planifiée : {time(nextRunAt)}
        <Text component="span" fz="xs" c="dimmed">
          {" "}
          (toutes les heures de 8 h à 23 h, puis 2 h et 5 h)
        </Text>
      </Text>
    </Group>
  ) : null;

  if (!progress) {
    return (
      <Stack gap="md">
        {header}
        <Text fz="sm" c="dimmed">
          Aucune collecte enregistrée pour l'instant.
        </Text>
        {nextRun}
      </Stack>
    );
  }

  const markets = progress.sources.filter((s) => s.id !== PUBLISH_STEP);
  const finished = progress.sources.filter(
    (s) => s.status === "done" || s.status === "failed",
  ).length;
  const started = new Date(progress.startedAt).getTime();
  const end = progress.finishedAt
    ? new Date(progress.finishedAt).getTime()
    : Math.max(now, new Date(progress.updatedAt).getTime());
  const estimatedEnd =
    running && progress.previousDurationMs
      ? started + progress.previousDurationMs
      : undefined;
  const totals = markets.reduce(
    (sum, s) => ({
      collected: sum.collected + (s.collected ?? 0),
      created: sum.created + (s.created ?? 0),
      updated: sum.updated + (s.updated ?? 0),
    }),
    { collected: 0, created: 0, updated: 0 },
  );
  const warnings = progress.events.filter((e) => e.level === "warn").length;
  const namesById = Object.fromEntries(
    progress.sources.map((s) => [s.id, s.name]),
  );
  const events = [...progress.events]
    .reverse()
    .filter((event) => filter === "all" || event.level === "warn");

  return (
    <Stack gap="md">
      {header}

      <Stack gap={6}>
        <Group gap={6}>
          <Badge
            variant="light"
            color={
              running ? "blue" : progress.status === "failed" ? "red" : "teal"
            }
            leftSection={running ? <Loader size={10} color="blue" /> : null}
          >
            {running
              ? "En cours"
              : progress.status === "failed"
                ? "Interrompue"
                : "Terminée"}
          </Badge>
          <Badge variant="outline" color="gray">
            {progress.trigger === "manual" ? "Manuelle" : "Planifiée"}
          </Badge>
        </Group>
        <Text fz="xs" c="dimmed" className="tnum">
          Démarrée à {time(progress.startedAt)} ·{" "}
          {running ? "en cours depuis" : "durée"} {f.duration(end - started)}
          {progress.finishedAt ? ` · finie à ${time(progress.finishedAt)}` : ""}
        </Text>
        {estimatedEnd ? (
          <Text fz="xs" c="dimmed" className="tnum">
            {estimatedEnd > now
              ? `Fin estimée vers ${time(new Date(estimatedEnd).toISOString())} (durée de la précédente : ${f.duration(progress.previousDurationMs ?? 0)})`
              : "Plus longue que la précédente collecte."}
          </Text>
        ) : null}
      </Stack>

      <Box>
        <Group justify="space-between" mb={4}>
          <Text fz="xs" c="dimmed">
            Étapes terminées
          </Text>
          <Text fz="xs" fw={600} className="tnum">
            {finished} / {progress.sources.length}
          </Text>
        </Group>
        <Progress
          value={(finished / Math.max(progress.sources.length, 1)) * 100}
          size="sm"
          color="blue"
          aria-label={`${finished} étapes terminées sur ${progress.sources.length}`}
        />
      </Box>

      <SimpleGrid cols={4} spacing="xs">
        <Figure label="offres" value={totals.collected} />
        <Figure label="nouvelles" value={totals.created} />
        <Figure label="mises à jour" value={totals.updated} />
        <Figure
          label="alertes"
          value={warnings}
          color={warnings ? "orange" : undefined}
        />
      </SimpleGrid>

      <Stack gap="xs">
        {progress.sources.map((source) => (
          <SourceCard key={source.id} source={source} now={now} />
        ))}
      </Stack>

      {nextRun}

      <Divider />

      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
            Journal ({progress.events.length})
          </Text>
          <SegmentedControl
            size="xs"
            value={filter}
            onChange={(value) => setFilter(value as "all" | "warn")}
            data={[
              { value: "all", label: "Tout" },
              { value: "warn", label: `Alertes (${warnings})` },
            ]}
          />
        </Group>
        {events.length === 0 ? (
          <Text fz="xs" c="dimmed">
            Rien à afficher.
          </Text>
        ) : null}
        {events.map((event, index) => (
          <Group
            key={`${event.at}-${index}`}
            gap={6}
            wrap="nowrap"
            align="flex-start"
          >
            <Text fz="xs" c="dimmed" className="tnum" style={{ flexShrink: 0 }}>
              {time(event.at, true)}
            </Text>
            <Text fz="xs" c={event.level === "warn" ? "orange" : undefined}>
              {event.sourceId ? (
                <Text component="span" fz="xs" fw={600}>
                  {namesById[event.sourceId] ?? event.sourceId} ·{" "}
                </Text>
              ) : null}
              {event.message}
            </Text>
          </Group>
        ))}
      </Stack>
    </Stack>
  );
};

/** The aside's content in a scroll area spanning its full height. */
export const CollectionProgressPanel: FC<{
  progress: Progress | null;
  nextRunAt: string | null;
  /** When the progress was last fetched (the clock between ticks). */
  polledAt: number;
  onClose: () => void;
}> = (props) => (
  <ScrollArea h="100%" type="auto" offsetScrollbars scrollbarSize={8} p="md">
    <CollectionProgressAside {...props} />
  </ScrollArea>
);

export default CollectionProgressAside;
