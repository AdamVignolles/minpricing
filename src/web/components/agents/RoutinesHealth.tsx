import { Badge, Group, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import type { FC } from "react";

import type { RoutineHealth } from "../../../api/services/agentHealth.ts";
import * as f from "../ui/format.ts";

const STATUS: Record<
  RoutineHealth["status"],
  { label: string; color: string }
> = {
  ok: { label: "Passée", color: "green" },
  running: { label: "En cours", color: "blue" },
  missed: { label: "Manquée", color: "red" },
};

/**
 * The scheduled cloud routines at a glance: did each one run at its last
 * slot (its dated file is on the server), and what did it change.
 */
const RoutinesHealth: FC<{ routines: RoutineHealth[] }> = ({ routines }) => (
  <SimpleGrid cols={{ base: 1, sm: 2, lg: 4 }} spacing="sm">
    {routines.map((r) => {
      const status = STATUS[r.status];
      return (
        <Paper
          key={r.id}
          withBorder
          p="sm"
          radius="md"
          style={
            r.status === "missed"
              ? { borderColor: "var(--mantine-color-red-6)" }
              : undefined
          }
        >
          <Stack gap={4}>
            <Group justify="space-between" wrap="nowrap" gap="xs">
              <Text fw={600} fz="sm" truncate>
                {r.name}
              </Text>
              <Badge size="sm" variant="light" color={status.color}>
                {status.label}
              </Badge>
            </Group>
            <Text fz="xs" c="dimmed">
              {r.schedule} · créneau du {f.dateTime(r.lastSlot)}
            </Text>
            <Text fz="xs">
              {r.lastRun
                ? `Fichier reçu à ${f.dateTime(r.lastRun)}`
                : r.status === "missed"
                  ? "Aucun fichier reçu pour ce créneau"
                  : "En attente de son fichier"}
            </Text>
            <Text fz="xs" c="dimmed" lineClamp={2}>
              {r.changes.length
                ? `Modifié : ${r.changes.join(", ")}`
                : "Aucun réglage modifié"}
            </Text>
          </Stack>
        </Paper>
      );
    })}
  </SimpleGrid>
);

export default RoutinesHealth;
