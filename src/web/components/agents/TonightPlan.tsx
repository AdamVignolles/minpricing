import {
  ActionIcon,
  Anchor,
  Badge,
  Group,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import { type FC, useState } from "react";

import type { PublishScheduleController } from "../../../api/controllers/PublishScheduleController.ts";
import type { ScheduleEntry } from "../../../api/services/PublishScheduleService.ts";
import Icon from "../ui/Icon.tsx";
import Section from "../ui/Section.tsx";

export interface TonightPlanData {
  date: string;
  entries: ScheduleEntry[];
  queue: Array<Record<string, unknown>>;
}

const STATUS: Record<
  ScheduleEntry["status"],
  { label: string; color: string }
> = {
  planned: { label: "Prévu", color: "blue" },
  running: { label: "En cours", color: "violet" },
  done: { label: "Fait", color: "teal" },
  skipped: { label: "Ignoré", color: "gray" },
  cancelled: { label: "Annulé", color: "gray" },
  failed: { label: "Échec", color: "red" },
};

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("fr-FR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/Paris",
  });

/**
 * Tonight's publishing plan, run by the server itself: the times the
 * agent drew, what each one published or why it didn't, with a way to
 * cancel or move a time that hasn't come yet.
 */
const TonightPlan: FC<{ initial: TonightPlanData }> = ({ initial }) => {
  const client = useClient<PublishScheduleController>();
  const [plan, setPlan] = useState(initial);
  const [editing, setEditing] = useState<string>();
  const [value, setValue] = useState("");

  const reload = async () =>
    setPlan(
      (await client.publishPlan({
        query: { date: plan.date },
      })) as TonightPlanData,
    );
  const act = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      notifications.show({ color: "teal", message: done });
      setEditing(undefined);
      await reload();
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Impossible",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const visible = plan.entries.filter(
    (e) => e.status !== "cancelled" || e.note?.startsWith("annulé par"),
  );

  return (
    <Section
      title="Ce soir"
      description="Le plan de publication tenu par le serveur : l'heure tirée, puis ce qui a été publié ou pourquoi rien ne l'a été."
    >
      <Paper p={visible.length ? 0 : "md"} style={{ overflow: "hidden" }}>
        {visible.length === 0 ? (
          <Text fz="sm" c="dimmed">
            Pas de plan pour aujourd'hui
            {plan.queue.length
              ? ""
              : " — la sélection de 17:00 ne l'a pas encore posé"}
            .
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={560}>
            <Table verticalSpacing="sm" horizontalSpacing="md">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Heure</Table.Th>
                  <Table.Th>État</Table.Th>
                  <Table.Th>Deal</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {visible.map((entry) => (
                  <Table.Tr key={entry.id}>
                    <Table.Td>
                      {editing === entry.id ? (
                        <TextInput
                          type="time"
                          size="xs"
                          w={110}
                          value={value}
                          onChange={(e) => setValue(e.currentTarget.value)}
                          aria-label="Nouvelle heure"
                        />
                      ) : (
                        <Text fw={600}>{time(entry.plannedAt)}</Text>
                      )}
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        <Badge
                          color={STATUS[entry.status].color}
                          variant="light"
                        >
                          {STATUS[entry.status].label}
                        </Badge>
                        {entry.dryRun ? (
                          <Badge color="gray" variant="outline">
                            À blanc
                          </Badge>
                        ) : null}
                      </Group>
                    </Table.Td>
                    <Table.Td>
                      <Stack gap={2}>
                        {entry.dealId ? (
                          <Anchor
                            component={Link}
                            href={`/deals/${entry.dealId}`}
                            fz="sm"
                            lineClamp={1}
                          >
                            {entry.title ?? entry.dealId}
                          </Anchor>
                        ) : (
                          <Text fz="sm" c="dimmed">
                            {entry.status === "planned"
                              ? "le meilleur deal restant"
                              : "—"}
                          </Text>
                        )}
                        {entry.dealabsUrl ? (
                          <Anchor
                            href={entry.dealabsUrl}
                            target="_blank"
                            fz="xs"
                          >
                            Voir sur Dealabs
                          </Anchor>
                        ) : null}
                        {entry.note && entry.status !== "planned" ? (
                          <Text
                            fz="xs"
                            c="dimmed"
                            style={{ whiteSpace: "pre-line" }}
                            lineClamp={4}
                          >
                            {entry.note}
                          </Text>
                        ) : null}
                      </Stack>
                    </Table.Td>
                    <Table.Td>
                      {entry.status === "planned" ? (
                        <Group gap={4} wrap="nowrap" justify="flex-end">
                          {editing === entry.id ? (
                            <>
                              <Tooltip label="Enregistrer l'heure">
                                <ActionIcon
                                  variant="light"
                                  aria-label="Enregistrer l'heure"
                                  onClick={() =>
                                    act(
                                      () =>
                                        client.moveEntry({
                                          params: { id: entry.id },
                                          body: { time: value },
                                        }),
                                      `Déplacé à ${value}`,
                                    )
                                  }
                                >
                                  <Icon name="check" size={14} />
                                </ActionIcon>
                              </Tooltip>
                              <Tooltip label="Laisser l'heure">
                                <ActionIcon
                                  variant="subtle"
                                  color="gray"
                                  aria-label="Laisser l'heure"
                                  onClick={() => setEditing(undefined)}
                                >
                                  <Icon name="close" size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </>
                          ) : (
                            <>
                              <Tooltip label="Changer l'heure">
                                <ActionIcon
                                  variant="subtle"
                                  aria-label="Changer l'heure"
                                  onClick={() => {
                                    setEditing(entry.id);
                                    setValue(time(entry.plannedAt));
                                  }}
                                >
                                  <Icon name="clock" size={14} />
                                </ActionIcon>
                              </Tooltip>
                              <Tooltip label="Annuler cette publication">
                                <ActionIcon
                                  variant="subtle"
                                  color="red"
                                  aria-label="Annuler cette publication"
                                  onClick={() =>
                                    act(
                                      () =>
                                        client.cancelEntry({
                                          params: { id: entry.id },
                                        }),
                                      "Publication annulée",
                                    )
                                  }
                                >
                                  <Icon name="close" size={14} />
                                </ActionIcon>
                              </Tooltip>
                            </>
                          )}
                        </Group>
                      ) : null}
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Paper>
    </Section>
  );
};

export default TonightPlan;
