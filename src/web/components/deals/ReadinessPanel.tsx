import { Alert, Badge, Group, List, Text } from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, useEffect, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import { MODERATION_REASON_LABELS } from "../../../api/services/dealabsModeration.ts";
import Icon from "../ui/Icon.tsx";

interface Check {
  rule: string;
  status: "ok" | "fix" | "block";
  reason: string;
}

/**
 * « Prêt pour Dealabs » (epic 29) on the deal page: what a moderator
 * would object to, judged without the merchant page (the publication
 * re-checks with it). On this page's button a block is only a warning;
 * the evening slots and the end-of-run batch skip the deal.
 */
export const ReadinessPanel: FC<{ dealId: string; version?: string }> = ({
  dealId,
  version,
}) => {
  const drafts = useClient<DraftsController>();
  const [state, setState] = useState<{
    status: "ok" | "fix" | "block";
    checks: Check[];
  }>();

  useEffect(() => {
    let stopped = false;
    drafts
      .readiness({ params: { id: dealId } })
      .then((res) => {
        if (!stopped) setState(res as typeof state);
      })
      .catch(() => undefined);
    return () => {
      stopped = true;
    };
  }, [drafts, dealId, version]);

  if (!state) return null;
  const problems = state.checks.filter((check) => check.status !== "ok");
  if (problems.length === 0) {
    return (
      <Group gap={6}>
        <Badge color="teal" variant="light">
          Prêt pour Dealabs
        </Badge>
        <Text fz="xs" c="dimmed">
          vendeur, image, langue, stock, conditions de prix et description
          vérifiés
        </Text>
      </Group>
    );
  }
  return (
    <Alert
      color={state.status === "block" ? "orange" : "blue"}
      variant="light"
      icon={<Icon name="alert" size={16} />}
      title={
        state.status === "block"
          ? "Pas prêt pour Dealabs : un modérateur masquerait ce post"
          : "Prêt pour Dealabs, avec une correction ajoutée à la publication"
      }
    >
      <List size="sm" spacing={2}>
        {problems.map((check) => (
          <List.Item key={check.rule}>{check.reason}</List.Item>
        ))}
      </List>
      {state.status === "block" ? (
        <Text fz="xs" c="dimmed" mt={4}>
          Les créneaux du soir et la fin de collecte ne le publieront pas. Ici,
          « Publication automatique » reste possible : à vous de juger.
        </Text>
      ) : null}
    </Alert>
  );
};

/** What Dealabs' moderators did with this deal's post, if anything. */
export const ModerationNotice: FC<{
  status?: string | null;
  reason?: string | null;
  message?: string | null;
  at?: string | null;
}> = ({ status, reason, message, at }) => {
  if (status !== "hidden" && status !== "deleted") return null;
  const label =
    MODERATION_REASON_LABELS[reason as keyof typeof MODERATION_REASON_LABELS] ??
    reason ??
    "";
  return (
    <Alert
      color={status === "deleted" ? "gray" : "red"}
      variant="light"
      icon={<Icon name="alert" size={16} />}
      title={`${status === "deleted" ? "Supprimé" : "Masqué"} par les modérateurs Dealabs${label ? ` : ${label}` : ""}`}
    >
      {message ? (
        <Text fz="sm" style={{ whiteSpace: "pre-wrap" }}>
          {message}
        </Text>
      ) : null}
      {at ? (
        <Text fz="xs" c="dimmed" mt={4}>
          Vu le{" "}
          {new Date(at).toLocaleString("fr-FR", { timeZone: "Europe/Paris" })} ·
          DealRadar ne répond jamais aux modérateurs : corrigez sur Dealabs.
        </Text>
      ) : null}
    </Alert>
  );
};
