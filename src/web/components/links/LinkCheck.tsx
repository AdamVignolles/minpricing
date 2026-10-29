import {
  Alert,
  Anchor,
  Badge,
  Group,
  Image,
  Loader,
  Paper,
  Stack,
  Text,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import { type FC, useEffect, useState } from "react";

import type {
  LinkView,
  LinksController,
} from "../../../api/controllers/LinksController.ts";
import * as f from "../ui/format.ts";
import Icon, { type IconName } from "../ui/Icon.tsx";

const POLL_MS = 1_500;

/** The check is over once its verdict step is written. */
export const checkFinished = (link: LinkView): boolean =>
  link.steps.some(
    (step) =>
      step.id === "verdict" &&
      (step.status === "done" || step.status === "failed"),
  ) || link.steps.length === 0;

const STEP: Record<
  LinkView["steps"][number]["status"],
  { icon?: IconName; color: string; word: string }
> = {
  pending: { color: "dimmed", word: "à venir" },
  running: { color: "blue", word: "en cours" },
  done: { icon: "check", color: "teal", word: "fait" },
  skipped: { icon: "chevronRight", color: "dimmed", word: "sans objet" },
  failed: { icon: "alert", color: "red", word: "échec" },
};

export const LinkSteps: FC<{ link: LinkView }> = ({ link }) => (
  <Stack gap={4}>
    {link.steps.map((step) => {
      const status = STEP[step.status];
      return (
        <Group key={step.id} gap={8} wrap="nowrap" align="flex-start">
          <Stack w={16} align="center" pt={2} style={{ flexShrink: 0 }}>
            {step.status === "running" ? (
              <Loader size={12} />
            ) : status.icon ? (
              <Icon
                name={status.icon}
                size={13}
                color={`var(--mantine-color-${status.color === "dimmed" ? "dimmed" : `${status.color}-6`})`}
              />
            ) : (
              <Text fz="xs" c="dimmed">
                ·
              </Text>
            )}
          </Stack>
          <Stack gap={0} style={{ minWidth: 0, flex: 1 }}>
            <Text
              fz="sm"
              fw={step.status === "running" ? 600 : undefined}
              c={step.status === "failed" ? "red" : undefined}
              opacity={
                step.status === "pending" || step.status === "skipped" ? 0.6 : 1
              }
            >
              {step.label}
              <Text span fz="xs" c="dimmed">
                {" "}
                — {status.word}
              </Text>
            </Text>
            {step.detail && step.id !== "verdict" ? (
              <Text
                fz="xs"
                c="dimmed"
                lineClamp={2}
                style={{ wordBreak: "break-word" }}
              >
                {step.detail}
              </Text>
            ) : null}
          </Stack>
        </Group>
      );
    })}
  </Stack>
);

/**
 * What the check concluded: the deal (price, discount in words, score)
 * when it is visible, otherwise the reason it isn't, as stored.
 */
export const LinkResult: FC<{ link: LinkView }> = ({ link }) => {
  const deal = link.deal;
  if (link.status === "ok" && deal) {
    return (
      <Paper withBorder p="sm" radius="md">
        <Group gap="md" wrap="nowrap" align="flex-start">
          {deal.imageUrl ? (
            <Image
              src={deal.imageUrl}
              alt=""
              w={72}
              h={72}
              fit="contain"
              radius="sm"
              style={{ flexShrink: 0 }}
            />
          ) : null}
          <Stack gap={4} style={{ minWidth: 0 }}>
            <Anchor
              component={Link}
              href={`/deals/${deal.id}`}
              fw={600}
              fz="sm"
              lineClamp={2}
            >
              {deal.title}
            </Anchor>
            <Group gap="xs">
              <Text fw={700} c="signal.6" className="tnum">
                {f.price(deal.currentPrice)}
              </Text>
              {deal.discountPercentage ? (
                <Badge color="signal" variant="light" className="tnum">
                  {f.discount(deal.discountPercentage)} sous le prix barré
                </Badge>
              ) : null}
              {deal.score !== undefined ? (
                <Badge variant="default">Note {deal.score}/100</Badge>
              ) : null}
            </Group>
            <Text fz="xs" c="dimmed">
              Ajouté aux bons plans, surveillé à chaque collecte {link.shop}.
            </Text>
          </Stack>
        </Group>
      </Paper>
    );
  }
  return (
    <Alert
      variant="light"
      color={link.status === "failed" ? "red" : "orange"}
      icon={<Icon name="alert" size={16} />}
      title={
        link.status === "failed"
          ? "Lecture impossible"
          : "Pas retenu pour l'instant"
      }
    >
      <Stack gap={4}>
        <Text fz="sm" style={{ wordBreak: "break-word" }}>
          {link.verdict}
        </Text>
        {deal ? (
          <Anchor component={Link} href={`/deals/${deal.id}`} fz="sm">
            Voir la fiche du produit
          </Anchor>
        ) : null}
      </Stack>
    </Alert>
  );
};

/**
 * One link being checked: polls `GET /links/:id` until the verdict is
 * written, showing the steps live, then the result.
 */
export const LinkCheck: FC<{ initial: LinkView }> = ({ initial }) => {
  const client = useClient<LinksController>();
  const [link, setLink] = useState(initial);
  const finished = checkFinished(link) && link.status !== "pending";

  useEffect(() => {
    if (finished) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const next = await client
        .linkDetail({ params: { id: initial.id } })
        .catch(() => undefined);
      if (stopped) return;
      if (next) setLink(next as LinkView);
      timer = setTimeout(poll, POLL_MS);
    };
    timer = setTimeout(poll, POLL_MS);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [client, initial.id, finished]);

  return (
    <Stack gap="sm">
      <Group gap={6}>
        <Icon name="store" size={14} color="var(--mantine-color-dimmed)" />
        <Text fz="xs" c="dimmed" style={{ wordBreak: "break-all" }}>
          {link.shop} · {link.canonicalUrl}
        </Text>
      </Group>
      <LinkSteps link={link} />
      {finished ? <LinkResult link={link} /> : null}
    </Stack>
  );
};
