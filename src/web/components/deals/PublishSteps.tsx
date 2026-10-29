import {
  Anchor,
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, useEffect, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import {
  currentPublishStep,
  type PublishRun,
  type PublishStep,
} from "../../../api/services/publishSteps.ts";
import Icon, { type IconName } from "../ui/Icon.tsx";

export interface PublishProgressState {
  current?: PublishRun;
  last?: PublishRun;
}

const POLL_MS = 1_500;

/**
 * The Dealabs publication in progress and the last one, polled while
 * `active` (a publish was started here, or one is already running). Stops
 * polling on its own once nothing runs. Errors are ignored: the next poll
 * tries again, and the page never breaks over a progress read.
 */
export const usePublishProgress = (active: boolean): PublishProgressState => {
  const drafts = useClient<DraftsController>();
  const [state, setState] = useState<PublishProgressState>({});

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await drafts.publishProgress({}).catch(() => undefined);
      if (stopped) return;
      if (next) setState(next as PublishProgressState);
      if (active || next?.current) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [active, drafts]);

  return state;
};

/**
 * The current time, every second, only while `active` (a running step's
 * elapsed seconds). 0 otherwise and during server rendering, which the
 * callers treat as « unknown ».
 */
const useSecondTicker = (active: boolean): number => {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    tick();
    const id = setInterval(tick, 1_000);
    return () => clearInterval(id);
  }, [active]);
  return now;
};

const STATUS: Record<
  PublishStep["status"],
  { icon?: IconName; color: string; word: string }
> = {
  pending: { color: "dimmed", word: "à venir" },
  running: { color: "blue", word: "en cours" },
  done: { icon: "check", color: "teal", word: "fait" },
  skipped: { icon: "chevronRight", color: "dimmed", word: "sans objet" },
  failed: { icon: "alert", color: "red", word: "échec" },
};

const seconds = (from?: string, to?: string | number): string | null => {
  if (!from || !to) return null;
  const ms = new Date(to).getTime() - new Date(from).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1_000) return "< 1 s";
  const s = Math.round(ms / 1_000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });

const TRIGGER: Record<PublishRun["trigger"], string> = {
  button: "bouton",
  schedule: "planning du soir",
  collection: "fin de collecte",
};

/**
 * One publication, phase by phase: what is done (and how long it took),
 * what is running, what was skipped and where it failed. A step that
 * waits for someone says so. `compact` shows only the current or failed
 * step on one line, for tables and cards.
 */
const PublishSteps: FC<{ run: PublishRun; compact?: boolean }> = ({
  run,
  compact,
}) => {
  const now = useSecondTicker(run.status === "running");
  const focus = currentPublishStep(run);

  if (compact) {
    if (run.status === "done") {
      return (
        <Text fz="xs" c="teal">
          Publié
          {run.finishedAt ? ` à ${time(run.finishedAt)}` : ""}
        </Text>
      );
    }
    if (!focus) return null;
    return (
      <Group gap={6} wrap="nowrap">
        {focus.status === "running" ? <Loader size={10} /> : null}
        <Text
          fz="xs"
          c={focus.status === "failed" ? "red" : undefined}
          lineClamp={1}
        >
          {focus.status === "failed" ? "Échec : " : ""}
          {focus.label}
          {focus.needsHuman ? " · action requise" : ""}
        </Text>
      </Group>
    );
  }

  const title =
    run.status === "running"
      ? "Publication en cours"
      : run.status === "done"
        ? "Publiée sur Dealabs"
        : `Échec à l'étape « ${focus?.label ?? "?"} »`;

  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap={6}>
        <Group justify="space-between" gap="xs">
          <Text fw={600} fz="sm">
            {title}
          </Text>
          <Text fz="xs" c="dimmed">
            {time(run.startedAt)} · {TRIGGER[run.trigger]}
            {run.finishedAt
              ? ` · ${seconds(run.startedAt, run.finishedAt)}`
              : ""}
          </Text>
        </Group>
        {run.steps.map((step) => {
          const status = STATUS[step.status];
          const took =
            step.status === "running"
              ? now
                ? seconds(step.startedAt, now)
                : null
              : step.status === "done" || step.status === "failed"
                ? seconds(step.startedAt, step.finishedAt)
                : null;
          return (
            <Group
              key={step.id}
              gap={8}
              wrap="nowrap"
              align="flex-start"
              opacity={
                step.status === "pending" || step.status === "skipped"
                  ? 0.55
                  : 1
              }
            >
              <Stack w={16} align="center" pt={2} style={{ flexShrink: 0 }}>
                {step.status === "running" ? (
                  <Loader size={12} />
                ) : status.icon ? (
                  <Icon
                    name={status.icon}
                    size={13}
                    color={`var(--mantine-color-${status.color === "dimmed" ? "dimmed" : `${status.color}-6`})`}
                  />
                ) : (
                  <Text fz="xs" c="dimmed">
                    ·
                  </Text>
                )}
              </Stack>
              <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
                <Group gap={6} wrap="nowrap" justify="space-between">
                  <Text
                    fz="sm"
                    fw={step.status === "running" ? 600 : undefined}
                    c={step.status === "failed" ? "red" : undefined}
                  >
                    {step.label}
                    <Text span fz="xs" c="dimmed">
                      {" "}
                      —{" "}
                      {step.status === "pending" && run.status !== "running"
                        ? "non atteint"
                        : status.word}
                    </Text>
                  </Text>
                  {took ? (
                    <Text fz="xs" c="dimmed" style={{ flexShrink: 0 }}>
                      {took}
                    </Text>
                  ) : null}
                </Group>
                {step.needsHuman ? (
                  <Badge
                    size="sm"
                    color="orange"
                    variant="light"
                    leftSection={<Icon name="eye" size={11} />}
                    w="fit-content"
                  >
                    Action requise dans l'écran distant
                  </Badge>
                ) : null}
                {step.detail ? (
                  <Text
                    fz="xs"
                    c={step.status === "failed" ? "red" : "dimmed"}
                    lineClamp={3}
                    style={{ wordBreak: "break-word" }}
                  >
                    {step.detail}
                  </Text>
                ) : null}
              </Stack>
            </Group>
          );
        })}
        {run.dealabsUrl ? (
          <Anchor href={run.dealabsUrl} target="_blank" fz="sm">
            Voir le post sur Dealabs
          </Anchor>
        ) : null}
      </Stack>
    </Paper>
  );
};

export default PublishSteps;
