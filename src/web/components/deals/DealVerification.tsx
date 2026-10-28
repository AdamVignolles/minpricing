import { Badge, Button, Group, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { useRouter } from "alepha/react/router";
import { type FC, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import type { Deal } from "../../types.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";
import { useNow } from "../ui/useNow.ts";

const LABELS: Record<string, string> = {
  ok: "Vérifié : en ligne et au bon prix",
  gone: "Échec : produit indisponible",
  "out-of-stock": "Échec : rupture de stock",
  "price-changed": "Échec : le prix a changé",
  "already-on-dealabs": "Déjà sur Dealabs",
  blocked: "Non confirmé : page illisible",
  unreachable: "Non confirmé : site injoignable",
};

/** Result of the last pre-post check, with a "Vérifier maintenant" button. */
const DealVerification: FC<{ deal: Deal }> = ({ deal }) => {
  const drafts = useClient<DraftsController>();
  const router = useRouter();
  const now = useNow();
  const [loading, setLoading] = useState(false);
  const verdict = deal.verifyVerdict;

  const verify = async () => {
    setLoading(true);
    try {
      const result = await drafts.publishCheck({ params: { id: deal.id } });
      notifications.show({
        message: result.ok
          ? "Deal vérifié : en ligne et au bon prix."
          : `${LABELS[result.verdict] ?? result.verdict}${result.reason ? ` — ${result.reason}` : ""}`,
        color: result.ok ? undefined : "orange",
      });
      await router.reload();
    } catch (error) {
      notifications.show({
        color: "red",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Group gap="xs" align="center">
      {verdict ? (
        <Badge variant="light" color={verdict === "ok" ? "teal" : "orange"}>
          {LABELS[verdict] ?? verdict}
          {deal.verifiedAt && now
            ? ` · ${f.relativeTime(deal.verifiedAt, now)}`
            : ""}
        </Badge>
      ) : (
        <Badge variant="light" color="gray">
          Pas encore vérifié
        </Badge>
      )}
      {verdict && verdict !== "ok" && deal.verifyReason ? (
        <Text size="xs" c="dimmed">
          {deal.verifyReason}
        </Text>
      ) : null}
      <Button
        size="compact-xs"
        variant="default"
        loading={loading}
        leftSection={<Icon name="refresh" size={12} />}
        onClick={() => void verify()}
      >
        Vérifier maintenant
      </Button>
    </Group>
  );
};

export default DealVerification;
