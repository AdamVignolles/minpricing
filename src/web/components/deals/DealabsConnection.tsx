import { Badge, Button, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { type FC, useCallback, useEffect, useRef, useState } from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";
import RemoteScreen from "./RemoteScreen.tsx";

export interface DealabsSessionStatus {
  available: boolean;
  connected: boolean;
  savedAt?: string;
  login?: {
    state: "waiting" | "saved" | "failed" | "cancelled";
    startedAt: string;
    message?: string;
  };
}

/**
 * Dealabs connection for auto-publish, without any terminal command:
 * « Se connecter à Dealabs » opens a login window on the server — shown
 * here as an « écran distant » when the server is the VM —, the session
 * is saved on its own once you're logged in there, and this row follows
 * it live. Reports the connected state up so the auto-publish
 * button can wait for it.
 */
const DealabsConnection: FC<{
  onStatus?: (status: DealabsSessionStatus) => void;
}> = ({ onStatus }) => {
  const drafts = useClient<DraftsController>();
  const [status, setStatus] = useState<DealabsSessionStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const previousState = useRef<string | undefined>(undefined);
  // Set by the effect below: lets "connect" restart the polling loop.
  const pollNow = useRef<() => void>(() => undefined);

  const apply = useCallback(
    (next: DealabsSessionStatus) => {
      setStatus(next);
      onStatus?.(next);
      if (
        previousState.current === "waiting" &&
        next.login?.state === "saved"
      ) {
        notifications.show({
          color: "signal",
          icon: <Icon name="check" size={16} />,
          title: "Connecté à Dealabs",
          message:
            "Session enregistrée : la publication automatique est prête.",
        });
      }
      previousState.current = next.login?.state;
    },
    [onStatus],
  );

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // Polls every 2 s only while a login window is open.
    async function poll(): Promise<void> {
      clearTimeout(timer);
      try {
        const next = (await drafts.dealabsSessionStatus(
          {},
        )) as DealabsSessionStatus;
        if (cancelled) return;
        apply(next);
        if (next.login?.state === "waiting") {
          timer = setTimeout(() => void poll(), 2_000);
        }
      } catch {
        // Status unknown: leave the row as is.
      }
    }

    pollNow.current = () => void poll();
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [drafts, apply]);

  const connect = async () => {
    setStarting(true);
    try {
      apply((await drafts.dealabsLogin({})) as DealabsSessionStatus);
      pollNow.current();
    } catch (error) {
      notifications.show({
        color: "red",
        icon: <Icon name="alert" size={16} />,
        title: "Connexion impossible",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setStarting(false);
    }
  };

  if (!status) return null;
  const waiting = status.login?.state === "waiting";

  return (
    <Stack gap={4}>
      <Group gap="sm" justify="space-between" wrap="wrap">
        <Group gap={8}>
          <Text fz="sm" fw={600}>
            Connexion Dealabs
          </Text>
          {waiting ? (
            <Badge
              color="blue"
              variant="light"
              leftSection={<Loader size={10} color="blue" />}
            >
              Connexion en cours
            </Badge>
          ) : status.connected ? (
            <Badge color="teal" variant="light">
              Connecté
            </Badge>
          ) : (
            <Badge color="gray" variant="light">
              Non connecté
            </Badge>
          )}
          {status.connected && status.savedAt && !waiting ? (
            <Text fz="xs" c="dimmed">
              session du {f.dateTime(status.savedAt)}
            </Text>
          ) : null}
        </Group>
        {status.available ? (
          <Button
            size="xs"
            variant={status.connected ? "default" : "filled"}
            loading={starting}
            disabled={waiting}
            leftSection={<Icon name="external" size={14} />}
            onClick={() => void connect()}
          >
            {status.connected ? "Se reconnecter" : "Se connecter à Dealabs"}
          </Button>
        ) : null}
      </Group>

      {waiting ? (
        <>
          <Text fz="xs" c="dimmed">
            Une fenêtre Dealabs vient de s'ouvrir sur le serveur :
            connectez-vous dedans (email, mot de passe, vérification
            éventuelle). Elle se fermera toute seule une fois connecté.
          </Text>
          <RemoteScreen hint="Cliquez sur « Connexion ou inscription » si besoin, puis sur chaque champ et tapez-le ci-dessous. La session s'enregistre toute seule une fois connecté." />
        </>
      ) : null}
      {status.login?.state === "failed" ||
      status.login?.state === "cancelled" ? (
        <Text fz="xs" c="orange">
          Connexion non terminée
          {status.login.message ? ` : ${status.login.message}` : "."}
        </Text>
      ) : null}
      {!status.available ? (
        <Text fz="xs" c="dimmed">
          La connexion et la publication automatique ne fonctionnent qu'avec le
          serveur lancé sur votre ordinateur.
        </Text>
      ) : null}
    </Stack>
  );
};

export default DealabsConnection;
