import { Badge, Group, Stack, Table, Text } from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, useEffect, useState } from "react";

import type { AdminController } from "../../../api/controllers/AdminController.ts";
import * as f from "../ui/format.ts";
import { EmptyState } from "../ui/States.tsx";

interface JournalRun {
  id: string;
  trigger: string;
  status: string;
  skipReason?: string;
  startedAt: string;
  durationMs: number | null;
  error?: string;
  switchedOff: string[];
  results: Array<{
    id: string;
    ms?: number;
    collected: number;
    created: number;
    updated: number;
    error?: string;
    lightpandaFallbacks?: number;
  }>;
}

const STATUS: Record<string, { label: string; color: string }> = {
  running: { label: "En cours", color: "blue" },
  ok: { label: "Réussie", color: "teal" },
  partial: { label: "Partielle", color: "orange" },
  failed: { label: "Échec", color: "red" },
  skipped: { label: "Ignorée", color: "gray" },
  cancelled: { label: "Arrêtée", color: "yellow" },
};

/** Journal des collectes: one line per run, with each source's yield. */
const CollectionJournal: FC = () => {
  const admin = useClient<AdminController>();
  const [runs, setRuns] = useState<JournalRun[] | undefined>();

  useEffect(() => {
    void admin
      .collectionJournal({ query: { size: 40 } })
      .then((rows) => setRuns(rows as JournalRun[]))
      .catch(() => setRuns([]));
  }, [admin]);

  if (!runs) return <Text c="dimmed">Chargement…</Text>;
  if (runs.length === 0) {
    return (
      <EmptyState
        title="Aucune collecte enregistrée"
        description="Chaque collecte (réussie, partielle, en échec ou ignorée) laisse une ligne ici."
      />
    );
  }

  return (
    <Table.ScrollContainer minWidth={640}>
      <Table verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Début</Table.Th>
            <Table.Th>Statut</Table.Th>
            <Table.Th>Durée</Table.Th>
            <Table.Th>Sources</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {runs.map((run) => {
            const status = STATUS[run.status] ?? STATUS.failed;
            const total = run.results.reduce((sum, r) => sum + r.collected, 0);
            return (
              <Table.Tr key={run.id}>
                <Table.Td className="tnum">
                  {new Date(run.startedAt).toLocaleString("fr-FR", {
                    day: "2-digit",
                    month: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                  <Text fz="xs" c="dimmed">
                    {run.trigger === "manual" ? "Manuelle" : "Planifiée"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge variant="light" color={status.color}>
                    {status.label}
                  </Badge>
                </Table.Td>
                <Table.Td className="tnum">
                  {run.durationMs !== null ? f.duration(run.durationMs) : "—"}
                </Table.Td>
                <Table.Td>
                  <Stack gap={2}>
                    {run.skipReason ? (
                      <Text fz="xs" c="dimmed">
                        {run.skipReason}
                      </Text>
                    ) : (
                      <Text fz="xs" c="dimmed">
                        {run.results.length} source(s) · {total} offre(s)
                      </Text>
                    )}
                    <Group gap={6}>
                      {run.results.map((r) => (
                        <Badge
                          key={r.id}
                          size="xs"
                          variant="outline"
                          color={r.error ? "red" : "gray"}
                          title={r.error}
                        >
                          {r.id} {r.collected}
                          {r.lightpandaFallbacks ? " ⚠" : ""}
                        </Badge>
                      ))}
                    </Group>
                    {run.error ? (
                      <Text fz="xs" c="red">
                        {run.error}
                      </Text>
                    ) : null}
                  </Stack>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};

export default CollectionJournal;
