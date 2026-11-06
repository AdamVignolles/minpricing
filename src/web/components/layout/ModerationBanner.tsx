import { Alert, Anchor, Button, Group, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import { type FC, useEffect, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import type { ModerationAlert } from "../../../api/services/DealabsModerationService.ts";
import Icon from "../ui/Icon.tsx";

/** How often the moderation alerts are re-read (the job runs every 20 min). */
const POLL_MS = 120_000;

const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("fr-FR", {
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Paris",
      })
    : "";

/**
 * Posts Dealabs' moderators hid or deleted (epic 29), on top of every
 * page until Adam closes them (« Vu »): what is asked, the deadline, a
 * link to the post. DealRadar never answers the moderators itself.
 */
const ModerationBanner: FC = () => {
  const drafts = useClient<DraftsController>();
  const [alerts, setAlerts] = useState<ModerationAlert[]>([]);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let stopped = false;
    const load = async () => {
      const res = await drafts
        .moderationStatus({ query: {} })
        .catch(() => null);
      if (!stopped && res) setAlerts(res.alerts as ModerationAlert[]);
    };
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [drafts, version]);

  if (alerts.length === 0) return null;
  return (
    <Stack gap="xs" mb="md">
      {alerts.map((alert) => (
        <Alert
          key={alert.dealId}
          color={alert.status === "deleted" ? "gray" : "red"}
          variant="light"
          icon={<Icon name="alert" size={16} />}
          title={
            alert.status === "deleted"
              ? `Deal supprimé par Dealabs : ${alert.label}`
              : `Deal masqué par Dealabs : ${alert.label}`
          }
        >
          <Group justify="space-between" align="flex-start" gap="sm">
            <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
              <Text fz="sm">
                <Anchor component={Link} href={`/deals/${alert.dealId}`}>
                  {alert.title}
                </Anchor>
                {alert.dealabsUrl ? (
                  <>
                    {" · "}
                    <Anchor href={alert.dealabsUrl} target="_blank">
                      voir le post
                    </Anchor>
                  </>
                ) : null}
              </Text>
              {alert.status === "hidden" && alert.deadline ? (
                <Text fz="xs" c="red">
                  À corriger sur Dealabs avant {when(alert.deadline)}, sinon il
                  sera supprimé.
                </Text>
              ) : null}
              {alert.message ? (
                <Text fz="xs" c="dimmed" lineClamp={3}>
                  {alert.message.replace(/\s*\[délai : \d+ h\]$/, "")}
                </Text>
              ) : null}
            </Stack>
            <Button
              size="xs"
              variant="default"
              onClick={async () => {
                try {
                  await drafts.dismissModeration({
                    params: { dealId: alert.dealId },
                  });
                  setVersion((v) => v + 1);
                } catch (error) {
                  notifications.show({
                    color: "red",
                    message:
                      error instanceof Error ? error.message : String(error),
                  });
                }
              }}
            >
              Vu
            </Button>
          </Group>
        </Alert>
      ))}
    </Stack>
  );
};

export default ModerationBanner;
