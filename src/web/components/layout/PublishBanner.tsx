import { Alert, Anchor, Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import { type FC, useEffect, useState } from "react";

import type { PublishScheduleController } from "../../../api/controllers/PublishScheduleController.ts";
import type { PublishPause } from "../../../api/services/PublishPauseService.ts";
import type { ScheduleEntry } from "../../../api/services/PublishScheduleService.ts";
import { currentPublishStep } from "../../../api/services/publishSteps.ts";
import { StopPublishButton } from "../agents/PublishControls.tsx";
import { usePublishProgress } from "../deals/PublishSteps.tsx";
import Icon from "../ui/Icon.tsx";
import { useNow } from "../ui/useNow.ts";

/** A planned slot this close (minutes) gets a warning on every page. */
export const PUBLISH_WARN_MINUTES = 10;
/** How often the plan is re-read for upcoming slots. */
const PLAN_POLL_MS = 30_000;

const time = (iso: string | number) =>
  new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });

/**
 * The publishing state that needs a decision, on top of every page:
 * - a publication running (its deal, current step, « Arrêter »);
 * - a scheduled slot due within {@link PUBLISH_WARN_MINUTES} (« Annuler »,
 *   « Reporter de 30 min »);
 * - publications paused (since when, until when).
 * Nothing at all otherwise. Reads are best-effort: an unreadable plan
 * just shows no warning.
 */
const PublishBanner: FC = () => {
  const schedule = useClient<PublishScheduleController>();
  const now = useNow();
  const [entries, setEntries] = useState<ScheduleEntry[]>([]);
  const [pause, setPause] = useState<PublishPause>({ paused: false });
  const [busy, setBusy] = useState<string>();

  // Bumped after an action so the plan is re-read at once.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const plan = await schedule.publishPlan({ query: {} }).catch(() => null);
      if (stopped || !plan) return;
      setEntries(plan.entries as ScheduleEntry[]);
      setPause(plan.pause as PublishPause);
    };
    void load();
    const id = setInterval(() => void load(), PLAN_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [schedule, version]);

  const upcoming = now
    ? entries
        .filter((e) => e.status === "planned" && !e.dryRun)
        .filter((e) => {
          const ms = new Date(e.plannedAt).getTime() - now;
          // Slightly past is still « imminent »: the job runs every 5 min.
          return ms <= PUBLISH_WARN_MINUTES * 60_000 && ms > -6 * 60_000;
        })
        .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))[0]
    : undefined;
  const watch = !!upcoming || entries.some((e) => e.status === "running");
  const progress = usePublishProgress(watch);
  const running = progress.current;

  const act = async (run: () => Promise<unknown>, done: string) => {
    setBusy(done);
    try {
      await run();
      notifications.show({ color: "teal", message: done });
      setVersion((v) => v + 1);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Impossible",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(undefined);
    }
  };

  if (running) {
    const step = currentPublishStep(running);
    return (
      <Alert
        color="blue"
        variant="light"
        mb="md"
        icon={<Icon name="flame" size={16} />}
        title="Publication sur Dealabs en cours"
      >
        <Group justify="space-between" gap="sm">
          <Text fz="sm">
            <Anchor component={Link} href={`/deals/${running.dealId}`}>
              {running.title}
            </Anchor>
            {step ? ` : ${step.label}` : ""}
            {step?.needsHuman ? " (action requise dans l'écran distant)" : ""}
          </Text>
          <StopPublishButton run={running} size="xs" />
        </Group>
      </Alert>
    );
  }

  if (upcoming && !pause.paused && now) {
    const minutes = Math.round(
      (new Date(upcoming.plannedAt).getTime() - now) / 60_000,
    );
    const later = new Date(
      new Date(upcoming.plannedAt).getTime() + 30 * 60_000,
    );
    const laterHhmm = time(later.toISOString());
    const sameDay =
      later.toLocaleDateString("fr-FR", { timeZone: "Europe/Paris" }) ===
      new Date(upcoming.plannedAt).toLocaleDateString("fr-FR", {
        timeZone: "Europe/Paris",
      });
    return (
      <Alert
        color="orange"
        variant="light"
        mb="md"
        icon={<Icon name="clock" size={16} />}
        title={
          minutes > 0
            ? `Publication dans ${minutes} min (${time(upcoming.plannedAt)})`
            : `Publication imminente (prévue à ${time(upcoming.plannedAt)})`
        }
      >
        <Group justify="space-between" gap="sm">
          <Text fz="sm">
            {upcoming.dealId ? (
              <Anchor component={Link} href={`/deals/${upcoming.dealId}`}>
                {upcoming.title ?? upcoming.dealId}
              </Anchor>
            ) : (
              "Le meilleur deal restant de la sélection du soir"
            )}
          </Text>
          <Group gap="xs">
            <Button
              size="xs"
              variant="default"
              loading={busy === "Reporté"}
              disabled={!sameDay}
              onClick={() =>
                act(
                  () =>
                    schedule.moveEntry({
                      params: { id: upcoming.id },
                      body: { time: laterHhmm },
                    }),
                  "Reporté",
                )
              }
            >
              Reporter à {laterHhmm}
            </Button>
            <Button
              size="xs"
              color="red"
              variant="light"
              loading={busy === "Annulé"}
              onClick={() =>
                act(
                  () => schedule.cancelEntry({ params: { id: upcoming.id } }),
                  "Annulé",
                )
              }
            >
              Annuler cette publication
            </Button>
          </Group>
        </Group>
      </Alert>
    );
  }

  if (pause.paused) {
    return (
      <Alert
        color="gray"
        variant="light"
        mb="md"
        icon={<Icon name="clock" size={16} />}
      >
        <Text fz="sm">
          Publications automatiques en pause
          {pause.until ? ` jusqu'à ${time(pause.until)}` : ""} : aucun créneau
          ni fin de collecte ne publie.{" "}
          <Anchor component={Link} href="/">
            Reprendre depuis le tableau de bord
          </Anchor>
        </Text>
      </Alert>
    );
  }

  return null;
};

export default PublishBanner;
