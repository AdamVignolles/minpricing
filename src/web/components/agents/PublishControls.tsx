import { Button, Group, Select, Switch, Text, Tooltip } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { type FC, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import type { PublishPause } from "../../../api/services/PublishPauseService.ts";
import {
  canStopPublish,
  type PublishRun,
} from "../../../api/services/publishSteps.ts";
import Icon from "../ui/Icon.tsx";

const parisTime = (iso: string) =>
  new Date(iso).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

const notifyError = (title: string, error: unknown) =>
  notifications.show({
    color: "red",
    title,
    message: error instanceof Error ? error.message : String(error),
  });

/**
 * « Arrêter » for the publication in progress. Two clicks (the first asks
 * to confirm), and disabled once « Envoi » has started: from there the
 * post may already exist, so a stop would be a lie.
 */
export const StopPublishButton: FC<{
  run: PublishRun;
  size?: "xs" | "sm";
  onStopped?: () => void;
}> = ({ run, size = "sm", onStopped }) => {
  const drafts = useClient<DraftsController>();
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);

  if (run.status !== "running") return null;
  if (run.stopRequest) {
    return (
      <Text fz="xs" c="orange">
        Arrêt demandé : s'arrête à la prochaine étape.
      </Text>
    );
  }
  if (!canStopPublish(run)) {
    return (
      <Tooltip label="« Poster un deal » a été cliqué : le post existe peut-être déjà.">
        <Button size={size} variant="default" disabled>
          Trop tard pour arrêter
        </Button>
      </Tooltip>
    );
  }

  const stop = async () => {
    setSending(true);
    try {
      const answer = await drafts.stopPublish({});
      notifications.show({
        color: answer.ok ? "orange" : "gray",
        message: answer.message,
      });
      onStopped?.();
    } catch (error) {
      notifyError("Arrêt impossible", error);
    } finally {
      setSending(false);
      setConfirming(false);
    }
  };

  return confirming ? (
    <Group gap={6} wrap="nowrap">
      <Button
        size={size}
        color="red"
        loading={sending}
        leftSection={<Icon name="close" size={14} />}
        onClick={() => void stop()}
      >
        Confirmer l'arrêt
      </Button>
      <Button size={size} variant="subtle" onClick={() => setConfirming(false)}>
        Non
      </Button>
    </Group>
  ) : (
    <Button
      size={size}
      color="red"
      variant="light"
      leftSection={<Icon name="close" size={14} />}
      onClick={() => setConfirming(true)}
    >
      Arrêter la publication
    </Button>
  );
};

const DURATIONS: Array<{ value: string; label: string; hours?: number }> = [
  { value: "none", label: "jusqu'à reprise" },
  { value: "1", label: "pendant 1 h", hours: 1 },
  { value: "4", label: "pendant 4 h", hours: 4 },
  { value: "24", label: "pendant 24 h", hours: 24 },
];

/**
 * « Publications automatiques » on/off: off pauses every scheduled slot and
 * the end-of-collection publishing (the deal page's button still works).
 * Shows since when, by whom and until when.
 */
export const PublishPauseSwitch: FC<{
  pause: PublishPause;
  onChange?: (pause: PublishPause) => void;
}> = ({ pause, onChange }) => {
  const drafts = useClient<DraftsController>();
  const [duration, setDuration] = useState("none");
  const [sending, setSending] = useState(false);

  const toggle = async (paused: boolean) => {
    setSending(true);
    try {
      const hours = DURATIONS.find((d) => d.value === duration)?.hours;
      const next = await drafts.setPublishPause({
        body: {
          paused,
          ...(paused && hours
            ? { until: new Date(Date.now() + hours * 3_600_000).toISOString() }
            : {}),
        },
      });
      onChange?.(next as PublishPause);
      notifications.show({
        color: paused ? "orange" : "teal",
        message: paused
          ? "Publications automatiques en pause."
          : "Publications automatiques reprises.",
      });
    } catch (error) {
      notifyError("Changement impossible", error);
    } finally {
      setSending(false);
    }
  };

  return (
    <Group gap="sm" wrap="wrap">
      <Switch
        checked={!pause.paused}
        disabled={sending}
        onChange={(e) => void toggle(!e.currentTarget.checked)}
        color="teal"
        label={
          pause.paused
            ? "Publications automatiques en pause"
            : "Publications automatiques actives"
        }
      />
      {pause.paused ? (
        <Text fz="xs" c="orange">
          {pause.since ? `depuis le ${parisTime(pause.since)}` : ""}
          {pause.by ? ` par ${pause.by}` : ""}
          {pause.until ? ` · reprise le ${parisTime(pause.until)}` : ""}
        </Text>
      ) : (
        <Select
          size="xs"
          w={150}
          data={DURATIONS.map(({ value, label }) => ({ value, label }))}
          value={duration}
          onChange={(value) => setDuration(value ?? "none")}
          aria-label="Durée de la pause"
          allowDeselect={false}
        />
      )}
    </Group>
  );
};
