import {
  Anchor,
  Badge,
  Button,
  Card,
  Group,
  List,
  Stack,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { type FC, useEffect, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import { DEALABS_STATUS_LABELS } from "../../../api/services/dealabsStatusLabels.ts";
import Icon from "../ui/Icon.tsx";

type Status = keyof typeof DEALABS_STATUS_LABELS;

interface StatusView {
  status: Status;
  url?: string;
  temperature?: number;
  postPrice?: number;
  checkedAt?: string;
  statusAt?: string;
  source?: string;
  postedBy?: string;
  history: Array<{
    at: string;
    from?: string;
    to: string;
    source: string;
    url?: string;
    temperature?: number;
  }>;
  othersLive?: { url: string; price: number; temperature: number };
  othersLiveStored?: boolean;
  note?: string;
}

const COLORS: Record<Status, string> = {
  not_published: "gray",
  live: "teal",
  expired: "yellow",
  hidden: "red",
  deleted: "red",
};

const SOURCES: Record<string, string> = {
  publish: "publication",
  profile: "notre profil Dealabs",
  thread: "la page du post",
  moderation: "message des modérateurs",
  "manual-verify": "lien collé à la main",
};

const POSTED_BY: Record<string, string> = {
  agent: "publié par les agents",
  button: "publié depuis la console",
  manual: "publié à la main sur Dealabs",
};

const when = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleString("fr-FR", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Paris",
      })
    : "";

const euro = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;

/**
 * « Sur Dealabs » (epic 32): our post's checked status — live, expired,
 * hidden, deleted or not published — its link and temperature, when it
 * was checked, the history of changes, and « Vérifier sur Dealabs », which
 * reads our profile, the post's page and a fresh search now.
 */
const DealabsStatusPanel: FC<{ dealId: string; version?: string }> = ({
  dealId,
  version,
}) => {
  const drafts = useClient<DraftsController>();
  const [view, setView] = useState<StatusView>();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let stopped = false;
    drafts
      .dealabsStatusOf({ params: { id: dealId } })
      .then((res) => {
        if (!stopped) setView(res as StatusView);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [drafts, dealId, version]);

  const check = async () => {
    setChecking(true);
    try {
      const res = (await drafts.checkDealabsStatus({
        params: { id: dealId },
      })) as StatusView;
      setView(res);
      notifications.show({
        color: "teal",
        message: `Sur Dealabs : ${DEALABS_STATUS_LABELS[res.status]}`,
      });
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Vérification impossible",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  };

  if (!view) return null;
  const label =
    view.status === "live" && view.temperature !== undefined
      ? `${DEALABS_STATUS_LABELS.live} · ${view.temperature}°`
      : DEALABS_STATUS_LABELS[view.status];
  return (
    <Card withBorder padding="sm">
      <Stack gap={6}>
        <Group justify="space-between" gap="xs">
          <Group gap="xs">
            <Text fw={600} fz="sm">
              Sur Dealabs
            </Text>
            <Badge color={COLORS[view.status]} variant="light">
              {label}
            </Badge>
            {view.url && view.status !== "not_published" ? (
              <Anchor href={view.url} target="_blank" fz="sm">
                voir le post
              </Anchor>
            ) : null}
          </Group>
          <Button
            size="xs"
            variant="default"
            loading={checking}
            leftSection={<Icon name="refresh" size={14} />}
            onClick={() => void check()}
          >
            Vérifier sur Dealabs
          </Button>
        </Group>
        <Text fz="xs" c="dimmed">
          {view.checkedAt
            ? `Vérifié le ${when(view.checkedAt)}${view.source ? ` (${SOURCES[view.source] ?? view.source})` : ""}`
            : view.status === "not_published"
              ? "Aucun post de notre part connu."
              : "Pas encore vérifié : la prochaine collecte le fera."}
          {view.postedBy
            ? ` · ${POSTED_BY[view.postedBy] ?? view.postedBy}`
            : ""}
          {view.postPrice !== undefined && view.status !== "not_published"
            ? ` · posté à ${euro(view.postPrice)}`
            : ""}
        </Text>
        {view.othersLive ? (
          <Text fz="sm">
            Déjà posté par un autre membre ·{" "}
            <Anchor href={view.othersLive.url} target="_blank">
              {view.othersLive.temperature}° à {euro(view.othersLive.price)}
            </Anchor>
          </Text>
        ) : view.othersLiveStored ? (
          <Text fz="sm">
            Un autre membre a un post en ligne pour ce produit.
          </Text>
        ) : null}
        {view.note ? (
          <Text fz="xs" c="orange">
            {view.note}
          </Text>
        ) : null}
        {view.history.length > 0 ? (
          <List size="xs" spacing={0} c="dimmed">
            {[...view.history].reverse().map((change) => (
              <List.Item key={`${change.at}-${change.to}`}>
                {when(change.at)} :{" "}
                {change.from
                  ? `${DEALABS_STATUS_LABELS[change.from as Status] ?? change.from} → `
                  : ""}
                {DEALABS_STATUS_LABELS[change.to as Status] ?? change.to} (
                {SOURCES[change.source] ?? change.source})
              </List.Item>
            ))}
          </List>
        ) : null}
      </Stack>
    </Card>
  );
};

export default DealabsStatusPanel;
