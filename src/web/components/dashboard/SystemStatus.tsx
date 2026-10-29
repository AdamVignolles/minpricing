import { Badge, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import { Link } from "alepha/react/router";
import type { FC } from "react";

import type { RoutineHealth } from "../../../api/services/agentHealth.ts";
import type { ScheduleEntry } from "../../../api/services/PublishScheduleService.ts";
import { currentPublishStep } from "../../../api/services/publishSteps.ts";
import { usePublishProgress } from "../deals/PublishSteps.tsx";
import * as f from "../ui/format.ts";
import Icon, { type IconName } from "../ui/Icon.tsx";
import { useNow } from "../ui/useNow.ts";

export interface DealabsSession {
  available: boolean;
  connected: boolean;
  savedAt?: string;
}

export interface CollectionState {
  running: boolean;
  nextRunAt: string;
  lastRun?: {
    status: string;
    startedAt?: string;
    completedAt?: string;
    durationMs: number | null;
  };
  /** Enabled sources whose last attempt failed after their last success. */
  failingSources: string[];
}

export interface SystemStatusProps {
  session?: DealabsSession;
  collection?: CollectionState;
  routines?: RoutineHealth[];
  tonight?: ScheduleEntry[];
  /** Automatic publishing paused by hand. */
  paused?: boolean;
}

type Tone = "ok" | "warn" | "bad" | "info" | "unknown";

const TONE: Record<Tone, string> = {
  ok: "green",
  warn: "orange",
  bad: "red",
  info: "blue",
  unknown: "gray",
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });

const Card: FC<{
  title: string;
  icon: IconName;
  tone: Tone;
  state: string;
  lines: Array<string | null | undefined>;
  href: string;
}> = ({ title, icon, tone, state, lines, href }) => (
  <Paper
    component={Link}
    href={href}
    p="md"
    className="lift"
    withBorder
    style={{
      display: "block",
      color: "inherit",
      borderColor: tone === "bad" ? "var(--mantine-color-red-6)" : undefined,
    }}
  >
    <Stack gap={6}>
      <Group justify="space-between" wrap="nowrap" gap="xs">
        <Group gap={6} wrap="nowrap">
          <Icon name={icon} size={14} color="var(--mantine-color-dimmed)" />
          <Text fz="sm" c="dimmed">
            {title}
          </Text>
        </Group>
        <Badge size="sm" variant="light" color={TONE[tone]}>
          {state}
        </Badge>
      </Group>
      {lines
        .filter((line): line is string => Boolean(line))
        .map((line) => (
          <Text key={line} fz="xs" c="dimmed" lineClamp={2}>
            {line}
          </Text>
        ))}
    </Stack>
  </Paper>
);

/**
 * What needs attention before anything else: can we publish (Dealabs
 * session), is the collection healthy, did the cloud routines run, and
 * what is planned tonight. Each card links to the page that fixes it. A
 * block whose data could not be read says so instead of looking healthy.
 */
const SystemStatus: FC<SystemStatusProps> = ({
  session,
  collection,
  routines,
  tonight,
  paused,
}) => {
  const now = useNow();
  // Polled only while a publication runs (button, schedule or collection).
  const publishing = usePublishProgress(false).current;
  const publishingStep = publishing && currentPublishStep(publishing);

  const sessionCard = !session ? (
    <Card
      title="Session Dealabs"
      icon="external"
      tone="unknown"
      state="Inconnue"
      lines={["Statut illisible"]}
      href="/admin"
    />
  ) : (
    <Card
      title="Session Dealabs"
      icon="external"
      tone={session.connected ? "ok" : "bad"}
      state={session.connected ? "Connectée" : "Déconnectée"}
      lines={
        session.connected
          ? [
              session.savedAt
                ? `Enregistrée ${f.relativeTime(session.savedAt, now) ?? f.date(session.savedAt)}`
                : null,
            ]
          : [
              "La publication automatique est bloquée tant qu'on ne se reconnecte pas.",
            ]
      }
      href="/admin"
    />
  );

  let collectionCard = (
    <Card
      title="Collecte"
      icon="refresh"
      tone="unknown"
      state="Inconnue"
      lines={["Statut illisible"]}
      href="/admin"
    />
  );
  if (collection) {
    const last = collection.lastRun;
    const failed = last?.status === "failed" || last?.status === "error";
    const failing = collection.failingSources;
    const tone: Tone = collection.running
      ? "info"
      : failed
        ? "bad"
        : failing.length > 0
          ? "warn"
          : last
            ? "ok"
            : "unknown";
    const state = collection.running
      ? "En cours"
      : failed
        ? "Échec"
        : failing.length > 0
          ? `${failing.length} source${failing.length > 1 ? "s" : ""} en erreur`
          : last
            ? "OK"
            : "Aucune";
    collectionCard = (
      <Card
        title="Collecte"
        icon="refresh"
        tone={tone}
        state={state}
        lines={[
          last?.completedAt
            ? `Dernière ${f.relativeTime(last.completedAt, now) ?? f.dateTime(last.completedAt)} · ${f.duration(last.durationMs)}`
            : null,
          collection.running
            ? null
            : `Prochaine à ${time(collection.nextRunAt)}`,
          failing.length > 0 ? `En erreur : ${failing.join(", ")}` : null,
        ]}
        href="/admin"
      />
    );
  }

  let routinesCard = (
    <Card
      title="Routines cloud"
      icon="clock"
      tone="unknown"
      state="Inconnues"
      lines={["Rapport de santé illisible"]}
      href="/agents"
    />
  );
  if (routines?.length) {
    const missed = routines.filter((r) => r.status === "missed");
    const running = routines.filter((r) => r.status === "running");
    routinesCard = (
      <Card
        title="Routines cloud"
        icon="clock"
        tone={missed.length ? "bad" : running.length ? "info" : "ok"}
        state={
          missed.length
            ? `${missed.length} manquée${missed.length > 1 ? "s" : ""}`
            : `${routines.length - running.length}/${routines.length} passées`
        }
        lines={[
          missed.length
            ? `Manquée : ${missed.map((r) => r.name).join(", ")}`
            : null,
          running.length
            ? `En cours : ${running.map((r) => r.name).join(", ")}`
            : null,
        ]}
        href="/agents"
      />
    );
  }

  let tonightCard = (
    <Card
      title="Publications ce soir"
      icon="flame"
      tone="unknown"
      state="Inconnu"
      lines={["Planning illisible"]}
      href="/agents?tab=activite"
    />
  );
  if (tonight) {
    const real = tonight.filter((e) => !e.dryRun && e.status !== "cancelled");
    const done = real.filter((e) => e.status === "done");
    const failed = real.filter((e) => e.status === "failed");
    const next = real
      .filter((e) => e.status === "planned")
      .sort((a, b) => a.plannedAt.localeCompare(b.plannedAt))[0];
    tonightCard = (
      <Card
        title="Publications ce soir"
        icon="flame"
        tone={
          publishing
            ? "info"
            : paused
              ? "warn"
              : failed.length
                ? "warn"
                : real.length
                  ? "ok"
                  : "unknown"
        }
        state={
          publishing
            ? "En cours"
            : paused
              ? "En pause"
              : real.length
                ? `${done.length}/${real.length} publiée${done.length > 1 ? "s" : ""}`
                : "Rien de prévu"
        }
        lines={[
          publishing
            ? `${publishing.title} : ${publishingStep?.label ?? "démarrage"}${publishingStep?.needsHuman ? " (action requise dans l'écran distant)" : ""}`
            : null,
          next
            ? paused
              ? "Créneaux sautés tant que la pause dure"
              : `Prochaine à ${time(next.plannedAt)}`
            : null,
          failed.length ? `${failed.length} en échec` : null,
          real.length ? null : "La sélection du soir n'a pas encore planifié.",
        ]}
        href={
          publishing ? `/deals/${publishing.dealId}` : "/agents?tab=activite"
        }
      />
    );
  }

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="md">
      {sessionCard}
      {collectionCard}
      {routinesCard}
      {tonightCard}
    </SimpleGrid>
  );
};

export default SystemStatus;
