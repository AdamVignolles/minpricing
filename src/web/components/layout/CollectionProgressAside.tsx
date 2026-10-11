import {
  ActionIcon,
  Badge,
  Box,
  Group,
  Loader,
  Progress,
  ScrollArea,
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

const POLL_RUNNING_MS = 2_000;
const POLL_IDLE_MS = 20_000;
/** A finished run stays on screen this long (unless closed). */
const SHOW_AFTER_FINISH_MS = 10 * 60 * 1000;

const STATUS: Record<
  Progress["sources"][number]["status"],
  { label: string; color: string }
> = {
  pending: { label: "En attente", color: "gray" },
  running: { label: "En cours", color: "blue" },
  done: { label: "Terminé", color: "teal" },
  failed: { label: "Échec", color: "red" },
};

/**
 * Polls the collection progress. Exposed as a hook so the layout can both
 * render the sidebar and decide whether the AppShell aside is open.
 */
export function useCollectionProgress() {
  const admin = useClient<AdminController>();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [dismissedRunId, setDismissedRunId] = useState<string | null>(null);
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
        next = (await admin.collectProgress({})) as Progress | null;
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
  const visible =
    !!progress &&
    progress.runId !== dismissedRunId &&
    (progress.status === "running" || recentlyFinished);

  return {
    progress,
    visible,
    running: progress?.status === "running",
    dismiss: () => setDismissedRunId(progress?.runId ?? null),
  };
}

/** Header chip: visible on every width while a run is going. */
export const CollectionRunningChip: FC<{
  progress: Progress | null;
  onClick: () => void;
}> = ({ progress, onClick }) => {
  if (progress?.status !== "running") return null;
  const done = progress.sources.filter(
    (s) => s.status === "done" || s.status === "failed",
  ).length;
  return (
    <Badge
      component="button"
      type="button"
      onClick={onClick}
      variant="light"
      color="blue"
      leftSection={<Loader size={10} color="blue" />}
      style={{ cursor: "pointer" }}
      className="tnum"
    >
      Collecte en cours · {done}/{progress.sources.length}
    </Badge>
  );
};

/**
 * What the collection is doing right now: which marketplace, which step,
 * how far into it, and what has happened so far — instead of a spinner
 * that says nothing for twenty minutes.
 */
const CollectionProgressAside: FC<{
  progress: Progress;
  onClose: () => void;
}> = ({ progress, onClose }) => {
  const finished = progress.sources.filter(
    (s) => s.status === "done" || s.status === "failed",
  ).length;
  const running = progress.status === "running";
  const elapsedMs =
    new Date(progress.finishedAt ?? progress.updatedAt).getTime() -
    new Date(progress.startedAt).getTime();
  const namesById = Object.fromEntries(
    progress.sources.map((s) => [s.id, s.name]),
  );

  return (
    <Stack gap="md" h="100%">
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={4}>
          <Title order={2} fz="md">
            Collecte
          </Title>
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
            <Text fz="xs" c="dimmed" className="tnum">
              {f.duration(elapsedMs)}
            </Text>
          </Group>
        </Stack>
        {!running ? (
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
        ) : null}
      </Group>

      <Box>
        <Group justify="space-between" mb={4}>
          <Text fz="xs" c="dimmed">
            Sources traitées
          </Text>
          <Text fz="xs" fw={600} className="tnum">
            {finished} / {progress.sources.length}
          </Text>
        </Group>
        <Progress
          value={(finished / Math.max(progress.sources.length, 1)) * 100}
          size="sm"
          color="blue"
          aria-label={`${finished} sources traitées sur ${progress.sources.length}`}
        />
      </Box>

      <Stack gap="sm">
        {progress.sources.map((source) => (
          <Box
            key={source.id}
            p="xs"
            style={{
              borderRadius: 8,
              background:
                source.status === "running"
                  ? "var(--app-surface-muted)"
                  : undefined,
            }}
          >
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text fz="sm" fw={600} truncate>
                {source.name}
              </Text>
              <Badge
                size="xs"
                variant="light"
                color={STATUS[source.status].color}
                style={{ flexShrink: 0 }}
              >
                {STATUS[source.status].label}
              </Badge>
            </Group>

            {source.status === "running" ? (
              <Stack gap={4} mt={6}>
                <Text fz="xs">{source.step ?? "Démarrage"}</Text>
                {source.total ? (
                  <>
                    <Progress
                      value={((source.done ?? 0) / source.total) * 100}
                      size="xs"
                      color="blue"
                      aria-label={`${source.done ?? 0} sur ${source.total}`}
                    />
                    <Text fz="xs" c="dimmed" className="tnum">
                      {source.done ?? 0} / {source.total}
                    </Text>
                  </>
                ) : null}
              </Stack>
            ) : null}

            {source.status === "done" ? (
              <Text fz="xs" c="dimmed" mt={4} className="tnum">
                {source.collected ?? 0} offres · {source.created ?? 0} nouvelles
                · {source.updated ?? 0} mises à jour
              </Text>
            ) : null}

            {source.status === "failed" && source.error ? (
              <Text fz="xs" c="red" mt={4} lineClamp={3}>
                {source.error}
              </Text>
            ) : null}
          </Box>
        ))}
      </Stack>

      <Stack gap={6} style={{ flex: 1, minHeight: 0 }}>
        <Text fz="xs" fw={700} c="dimmed" tt="uppercase">
          Journal
        </Text>
        <ScrollArea style={{ flex: 1 }}>
          <Stack gap={6}>
            {[...progress.events].reverse().map((event, index) => (
              <Group
                key={`${event.at}-${index}`}
                gap={6}
                wrap="nowrap"
                align="flex-start"
              >
                <Text
                  fz="xs"
                  c="dimmed"
                  className="tnum"
                  style={{ flexShrink: 0 }}
                >
                  {new Date(event.at).toLocaleTimeString("fr-FR", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
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
        </ScrollArea>
      </Stack>
    </Stack>
  );
};

export default CollectionProgressAside;
