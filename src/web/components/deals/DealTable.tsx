import {
  Anchor,
  Badge,
  Box,
  Button,
  Group,
  Paper,
  Progress,
  Stack,
  Table,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { Link } from "alepha/react/router";
import { type FC, type ReactNode, useState } from "react";

import type { Deal, RefItem } from "../../types.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";
import { useNow } from "../ui/useNow.ts";
import {
  dealabsSignal,
  dropSignal,
  reviewsLine,
  sellerLine,
} from "./dealSignals.ts";
import { HEAT, heatLabel } from "./HeatForecast.tsx";

/** Sort keys of `GET /deals` a column header can ask for. */
export type TableSort =
  | "relevance"
  | "hot"
  | "discount"
  | "price-asc"
  | "price-desc"
  | "newest";

export interface DealTableProps {
  deals: Deal[];
  merchants?: RefItem[];
  sortBy: TableSort;
  onSort: (sortBy: TableSort) => void;
}

const merchantName = (deal: Deal, merchants?: RefItem[]) =>
  merchants?.find((row) => row.id === deal.merchantId)?.name ??
  f.titleize(deal.merchantId ?? deal.sourceId);

/**
 * The product image, or a grey placeholder when there is none or the
 * shop's link doesn't load (a broken image icon is noise in a list).
 */
const Thumb: FC<{ deal: Deal; size: number }> = ({ deal, size }) => {
  const [failed, setFailed] = useState<string>();
  return deal.imageUrl && failed !== deal.imageUrl ? (
    <img
      src={deal.imageUrl}
      alt=""
      loading="lazy"
      width={size}
      height={size}
      onError={() => setFailed(deal.imageUrl)}
      // Server-rendered: the image may have failed before hydration.
      ref={(el) => {
        if (el?.complete && el.naturalWidth === 0) setFailed(deal.imageUrl);
      }}
      style={{
        width: size,
        height: size,
        objectFit: "contain",
        background: "#fff",
        borderRadius: 8,
        flex: "none",
      }}
    />
  ) : (
    <Box
      w={size}
      h={size}
      bg="var(--app-surface-muted)"
      style={{
        borderRadius: 8,
        flex: "none",
        display: "grid",
        placeItems: "center",
      }}
    >
      <Icon name="image" size={16} aria-hidden />
    </Box>
  );
};

/** « −31 % vs plus bas 30 j »: lime only when the reference is trusted. */
const Drop: FC<{ deal: Deal; compact?: boolean }> = ({ deal, compact }) => {
  const drop = dropSignal(deal);
  if (!drop) {
    return (
      <Text fz="xs" c="dimmed">
        Pas de référence
      </Text>
    );
  }
  const badge = (
    <Badge
      size="sm"
      variant="light"
      color={drop.trusted ? "signal" : "gray"}
      className="tnum"
      style={{ flexShrink: 0 }}
    >
      {drop.free ? "Gratuit" : f.discount(drop.percent)}
    </Badge>
  );
  if (drop.free) return badge;
  const tip = `${drop.percent} % de moins que le ${drop.against}${drop.price ? ` (${f.price(drop.price, deal.currency)})` : ""}${drop.trusted ? "" : " : référence indicative"}`;
  return (
    <Tooltip label={tip} withArrow>
      <Group gap={6} wrap={compact ? "nowrap" : "wrap"}>
        {badge}
        <Text fz="xs" c="dimmed">
          vs {drop.against}
        </Text>
      </Group>
    </Tooltip>
  );
};

const Heat: FC<{ chance?: number }> = ({ chance }) => {
  if (chance === undefined || chance === null) {
    return (
      <Text fz="xs" c="dimmed">
        —
      </Text>
    );
  }
  const tier = HEAT[heatLabel(chance)];
  return (
    <Tooltip
      label={`${tier.label} : ${chance} % de chances d'atteindre 100° sur Dealabs (estimation)`}
      withArrow
    >
      <Stack gap={3}>
        <Progress
          value={Math.max(chance, 2)}
          color={tier.color}
          size="sm"
          w={64}
          aria-hidden
        />
        <Text fz="xs" className="tnum" style={{ whiteSpace: "nowrap" }}>
          {chance} % de 100°
        </Text>
      </Stack>
    </Tooltip>
  );
};

const ScoreBadge: FC<{ score: number }> = ({ score }) => (
  <Tooltip label="Note du deal (prix réel, vendeur, avis)" withArrow>
    <Badge
      size="sm"
      variant="light"
      color={score >= 60 ? "teal" : score >= 45 ? "yellow" : "gray"}
      className="tnum"
    >
      {score}/100
    </Badge>
  </Tooltip>
);

const PriceCell: FC<{ deal: Deal; align?: "left" | "right" }> = ({
  deal,
  align = "left",
}) => (
  <Stack gap={0} align={align === "right" ? "flex-end" : "flex-start"}>
    <Text fw={700} c="signal" className="tnum" style={{ whiteSpace: "nowrap" }}>
      {f.price(deal.currentPrice, deal.currency)}
      {deal.billingPeriod === "month" ? (
        <Text component="span" fz="xs" fw={500} c="dimmed">
          {" "}
          /mois
        </Text>
      ) : null}
    </Text>
    {deal.listPrice && deal.listPrice > deal.currentPrice ? (
      <Text fz="xs" c="dimmed" td="line-through" className="tnum">
        {f.price(deal.listPrice, deal.currency)}
      </Text>
    ) : null}
  </Stack>
);

/**
 * When the deal was added, or when its price last really dropped
 * (`freshAt`, see freshness.ts), with the exact dates in the tooltip.
 * Nothing on the server render (`now` is 0 until hydration).
 */
const When: FC<{ deal: Deal; now: number }> = ({ deal, now }) => {
  const at = deal.freshAt ?? deal.firstSeenAt;
  const ago = now ? f.relativeTime(at, now) : null;
  if (!ago) return null;
  const dropped = deal.freshReason === "price-drop";
  const recent = now - new Date(at).getTime() < 86_400_000;
  return (
    <Tooltip
      label={`${dropped ? "Prix en baisse" : "Ajouté"} le ${f.dateTime(at)} · dernière lecture ${f.dateTime(deal.lastSeenAt)}`}
      withArrow
    >
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
        <Icon name="clock" size={12} aria-hidden />
        <Text
          fz="xs"
          fw={recent ? 600 : 400}
          c={recent ? undefined : "dimmed"}
          truncate
        >
          {dropped
            ? `Prix baissé ${ago}${deal.droppedFrom ? ` · était ${f.price(deal.droppedFrom, deal.currency)}` : ""}`
            : `Ajouté ${ago}`}
        </Text>
      </Group>
    </Tooltip>
  );
};

/**
 * « Bons plans », design A of epic 30 (« Lire vite »): one row per deal
 * with the four things read first — price and real drop, Dealabs, chances,
 * seller and reviews. Sortable headers on desktop; on a phone each row
 * folds into a two-line card. Deals already ours on Dealabs are greyed.
 */
const DealTable: FC<DealTableProps> = ({
  deals,
  merchants,
  sortBy,
  onSort,
}) => {
  const now = useNow();
  const header = (label: string, sorts: TableSort[], first: TableSort) => {
    const active = sorts.includes(sortBy);
    const next =
      active && sorts.length > 1
        ? sorts[(sorts.indexOf(sortBy) + 1) % sorts.length]
        : first;
    return (
      <UnstyledButton
        onClick={() => onSort(next)}
        aria-sort={
          active
            ? sortBy === "price-asc"
              ? "ascending"
              : "descending"
            : undefined
        }
        fz="xs"
        fw={active ? 700 : 600}
        c={active ? undefined : "dimmed"}
        style={{
          textTransform: "uppercase",
          letterSpacing: "0.05em",
          whiteSpace: "nowrap",
        }}
      >
        {label}
        {active ? (sortBy === "price-asc" ? " ↑" : " ↓") : ""}
      </UnstyledButton>
    );
  };
  const plain = (label: string): ReactNode => (
    <Text
      fz="xs"
      fw={600}
      c="dimmed"
      style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
    >
      {label}
    </Text>
  );

  return (
    <>
      <Paper visibleFrom="lg" p={0} style={{ overflow: "hidden" }}>
        <Table
          verticalSpacing="sm"
          horizontalSpacing="sm"
          highlightOnHover
          layout="fixed"
        >
          <Table.Thead bg="var(--app-surface-muted)">
            <Table.Tr>
              <Table.Th w={92} />
              <Table.Th>
                {header("Produit · ajouté", ["newest"], "newest")}
              </Table.Th>
              <Table.Th w={100}>
                {header("Prix", ["price-asc", "price-desc"], "price-asc")}
              </Table.Th>
              <Table.Th w={150}>
                {header("Vraie baisse", ["discount"], "discount")}
              </Table.Th>
              <Table.Th w={84}>
                {header("Note", ["relevance"], "relevance")}
              </Table.Th>
              <Table.Th w={116}>{header("Potentiel", ["hot"], "hot")}</Table.Th>
              <Table.Th w={150}>{plain("Vendeur · avis")}</Table.Th>
              <Table.Th w={150}>{plain("Dealabs")}</Table.Th>
              <Table.Th w={44} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {deals.map((deal) => {
              const dealabs = dealabsSignal(deal);
              const href = `/deals/${deal.id}`;
              return (
                <Table.Tr
                  key={deal.id}
                  style={dealabs.posted ? { opacity: 0.55 } : undefined}
                >
                  <Table.Td>
                    <Thumb deal={deal} size={72} />
                  </Table.Td>
                  <Table.Td>
                    <Anchor
                      component={Link}
                      href={href}
                      c="inherit"
                      fz="sm"
                      fw={600}
                      lh={1.35}
                      className="clamp-2"
                      title={deal.title}
                    >
                      {deal.shortTitle ?? deal.title}
                    </Anchor>
                    <Text fz="xs" c="dimmed" truncate>
                      {merchantName(deal, merchants)}
                      {deal.addedByLink ? " · ajouté par lien" : ""}
                    </Text>
                    <When deal={deal} now={now} />
                  </Table.Td>
                  <Table.Td>
                    <PriceCell deal={deal} />
                  </Table.Td>
                  <Table.Td>
                    <Drop deal={deal} />
                  </Table.Td>
                  <Table.Td>
                    <ScoreBadge score={deal.score} />
                  </Table.Td>
                  <Table.Td>
                    <Heat chance={deal.hotChance} />
                  </Table.Td>
                  <Table.Td>
                    <Text fz="xs" lineClamp={2}>
                      {sellerLine(deal, merchants)}
                    </Text>
                    <Text fz="xs" c="dimmed" className="tnum">
                      {reviewsLine(deal)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge
                      size="sm"
                      variant="light"
                      color={dealabs.color}
                      className="tnum"
                      styles={{
                        label: { whiteSpace: "normal", lineHeight: 1.3 },
                      }}
                      h="auto"
                      py={2}
                    >
                      {dealabs.label}
                    </Badge>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4} wrap="nowrap" justify="flex-end">
                      <Tooltip label="Voir chez le marchand" withArrow>
                        <Button
                          component="a"
                          href={deal.url}
                          target="_blank"
                          rel="noreferrer"
                          size="compact-sm"
                          variant="subtle"
                          color="gray"
                          px={6}
                          aria-label="Voir chez le marchand"
                        >
                          <Icon name="external" size={14} />
                        </Button>
                      </Tooltip>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      </Paper>

      <Stack hiddenFrom="lg" gap={8}>
        {deals.map((deal) => {
          const dealabs = dealabsSignal(deal);
          return (
            <Paper
              key={deal.id}
              component={Link}
              href={`/deals/${deal.id}`}
              p="sm"
              style={{
                color: "inherit",
                ...(dealabs.posted ? { opacity: 0.55 } : {}),
              }}
            >
              <Group gap="sm" align="flex-start" wrap="nowrap">
                <Thumb deal={deal} size={72} />
                <Stack gap={6} style={{ flex: 1, minWidth: 0 }}>
                  <Group
                    gap="xs"
                    align="flex-start"
                    wrap="nowrap"
                    justify="space-between"
                  >
                    <Text
                      fz="sm"
                      fw={600}
                      lh={1.3}
                      className="clamp-2"
                      style={{ minWidth: 0 }}
                    >
                      {deal.shortTitle ?? deal.title}
                    </Text>
                    <PriceCell deal={deal} align="right" />
                  </Group>
                  <Group gap={6} wrap="wrap">
                    <Drop deal={deal} compact />
                    <ScoreBadge score={deal.score} />
                    {deal.hotChance !== undefined ? (
                      <Badge
                        size="sm"
                        variant="light"
                        color={HEAT[heatLabel(deal.hotChance)].color}
                        className="tnum"
                      >
                        {deal.hotChance} % de 100°
                      </Badge>
                    ) : null}
                    <Badge size="sm" variant="light" color={dealabs.color}>
                      {dealabs.label}
                    </Badge>
                  </Group>
                  <Text fz="xs" c="dimmed" truncate>
                    {merchantName(deal, merchants)} ·{" "}
                    {sellerLine(deal, merchants)} · {reviewsLine(deal)}
                  </Text>
                  <When deal={deal} now={now} />
                </Stack>
              </Group>
            </Paper>
          );
        })}
      </Stack>
    </>
  );
};

export default DealTable;
