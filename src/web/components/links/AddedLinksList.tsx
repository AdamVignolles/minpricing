import {
  Anchor,
  Badge,
  Button,
  Group,
  Stack,
  Table,
  Text,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import { type FC, useEffect, useState } from "react";

import type {
  LinkView,
  LinksController,
} from "../../../api/controllers/LinksController.ts";
import * as f from "../ui/format.ts";
import { EmptyState } from "../ui/States.tsx";
import { useNow } from "../ui/useNow.ts";
import { checkFinished } from "./LinkCheck.tsx";

const STATUS: Record<LinkView["status"], { label: string; color: string }> = {
  pending: { label: "En vérification", color: "blue" },
  ok: { label: "Visible", color: "teal" },
  refused: { label: "Pas retenu", color: "orange" },
  failed: { label: "Illisible", color: "red" },
  ended: { label: "Plus surveillé", color: "gray" },
};

/** Re-read while a check runs, so its row moves on by itself. */
const POLL_MS = 5_000;

/**
 * « Liens ajoutés »: every pasted link, what its last check concluded,
 * its deal, and the buttons to check it again or stop watching it.
 */
const AddedLinksList: FC = () => {
  const client = useClient<LinksController>();
  const now = useNow();
  const [links, setLinks] = useState<LinkView[]>();
  const [busy, setBusy] = useState<string>();
  const [version, setVersion] = useState(0);
  const running = links?.some(
    (link) => link.status !== "ended" && !checkFinished(link),
  );

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      const result = await client
        .listLinks({ query: { size: 100 } })
        .catch(() => undefined);
      if (stopped) return;
      if (result) setLinks(result.links as LinkView[]);
      if (running) timer = setTimeout(load, POLL_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, version, running]);

  const act = async (id: string, run: () => Promise<unknown>, done: string) => {
    setBusy(id);
    try {
      await run();
      notifications.show({ color: "teal", message: done });
      setVersion((v) => v + 1);
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Impossible",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(undefined);
    }
  };

  if (!links) return null;
  if (links.length === 0) {
    return (
      <EmptyState
        icon="inbox"
        title="Aucun lien ajouté"
        description="Collez le lien d'une fiche produit dans le champ « Ajouter un lien » du tableau de bord ou des bons plans."
      />
    );
  }

  return (
    <Table.ScrollContainer minWidth={760}>
      <Table verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Produit</Table.Th>
            <Table.Th>État</Table.Th>
            <Table.Th>Dernière vérification</Table.Th>
            <Table.Th>Verdict</Table.Th>
            <Table.Th />
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {links.map((link) => {
            const status = STATUS[link.status];
            const inProgress = link.status !== "ended" && !checkFinished(link);
            return (
              <Table.Tr key={link.id}>
                <Table.Td maw={320}>
                  <Stack gap={2}>
                    {link.deal ? (
                      <Anchor
                        component={Link}
                        href={`/deals/${link.deal.id}`}
                        fz="sm"
                        lineClamp={2}
                      >
                        {link.deal.title}
                      </Anchor>
                    ) : (
                      <Anchor
                        href={link.canonicalUrl}
                        target="_blank"
                        fz="sm"
                        style={{ wordBreak: "break-all" }}
                      >
                        {link.canonicalUrl}
                      </Anchor>
                    )}
                    <Text fz="xs" c="dimmed">
                      {link.shop} · ajouté par {link.addedBy}
                      {link.deal ? ` · ${f.price(link.deal.currentPrice)}` : ""}
                    </Text>
                  </Stack>
                </Table.Td>
                <Table.Td miw={130}>
                  <Badge
                    style={{ overflow: "visible" }}
                    color={inProgress ? "blue" : status.color}
                    variant="light"
                  >
                    {inProgress ? "En vérification" : status.label}
                  </Badge>
                </Table.Td>
                <Table.Td>
                  <Text fz="xs" c="dimmed">
                    {link.lastCheckedAt
                      ? (f.relativeTime(link.lastCheckedAt, now) ??
                        f.dateTime(link.lastCheckedAt))
                      : "pas encore"}
                  </Text>
                  {link.status !== "ended" ? (
                    <Text fz="xs" c="dimmed">
                      suivi jusqu'au {f.date(link.watchUntil)}
                    </Text>
                  ) : null}
                </Table.Td>
                <Table.Td maw={380}>
                  <Text
                    fz="xs"
                    lineClamp={3}
                    style={{ wordBreak: "break-word" }}
                  >
                    {link.verdict ?? "—"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={6} wrap="nowrap" justify="flex-end">
                    <Button
                      size="compact-xs"
                      variant="default"
                      loading={busy === link.id}
                      disabled={inProgress}
                      onClick={() =>
                        act(
                          link.id,
                          () => client.recheckLink({ params: { id: link.id } }),
                          "Nouvelle vérification lancée",
                        )
                      }
                    >
                      Revérifier
                    </Button>
                    {link.status !== "ended" ? (
                      <Button
                        size="compact-xs"
                        variant="subtle"
                        color="red"
                        disabled={busy === link.id}
                        onClick={() =>
                          act(
                            link.id,
                            () => client.stopLink({ params: { id: link.id } }),
                            "Lien plus surveillé",
                          )
                        }
                      >
                        Arrêter
                      </Button>
                    ) : null}
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
};

export default AddedLinksList;
