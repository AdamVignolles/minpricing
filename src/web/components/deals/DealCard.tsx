import { Badge, Card, Group, Stack, Text, Tooltip } from "@mantine/core";
import { Link } from "alepha/react/router";
import type { FC } from "react";

import type { Deal, RefItem } from "../../types.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";
import { useNow } from "../ui/useNow.ts";
import DealImage from "./DealImage.tsx";
import { HeatBadge } from "./HeatForecast.tsx";

const DAY_MS = 86_400_000;

export interface DealCardProps {
  deal: Deal;
  /** Merchant rows, so the card can show "Amazon" instead of `amazon`. */
  merchants?: RefItem[];
  /** `eager` images for the first row only — see `DealImage`. */
  priority?: boolean;
  /** Compact cards drop the image: used in dense rails and side lists. */
  compact?: boolean;
}

const labelFor = (id: string | undefined, rows: RefItem[] | undefined) => {
  if (!id) return null;
  return rows?.find((row) => row.id === id)?.name ?? f.titleize(id);
};

/**
 * The unit the whole product is built from.
 *
 * The reading order is fixed and deliberate, because a user scanning a grid
 * gives a card roughly a second: discount → image → title → price → saving →
 * where and when. Typography does the ranking; nothing here relies on colour
 * alone, and every discount is stated twice (percentage *and* euros) so the
 * lime chip is a shortcut rather than the only carrier of the information.
 */
const DealCard: FC<DealCardProps> = ({
  deal,
  merchants,
  priority,
  compact,
}) => {
  const now = useNow();
  const saving = f.savings(deal.currentPrice, deal.listPrice);
  const hasDiscount = (deal.discountPercentage ?? 0) >= 1;
  const merchant =
    labelFor(deal.merchantId, merchants) ?? f.titleize(deal.sourceId);
  // `now` is 0 until hydration: no clock, no "new" badge, no mismatch.
  // "New" means first seen or a real price drop — not merely seen again
  // by the last run (that's in the tooltip).
  const freshAt = deal.freshAt ?? deal.firstSeenAt;
  const seen = now ? f.relativeTime(freshAt, now) : null;
  const isFresh = now > 0 && now - new Date(freshAt).getTime() < DAY_MS;
  const isNew = isFresh && deal.freshReason !== "price-drop";
  const isDrop = isFresh && deal.freshReason === "price-drop";
  // Already on Dealabs: still openable, but out of the way.
  const posted = deal.onDealabs;
  const postedLabel = posted
    ? posted.mine
      ? "Publié par vous"
      : `Déjà sur Dealabs${posted.temperature ? ` · ${posted.temperature}°` : ""}`
    : null;

  return (
    <Card
      component={Link}
      href={`/deals/${deal.id}`}
      padding={compact ? "sm" : "md"}
      className="lift"
      h="100%"
      title={
        posted
          ? posted.mine
            ? "Vous avez déjà publié ce deal sur Dealabs."
            : "Un deal pour ce produit, au même prix ou moins cher, est déjà en ligne sur Dealabs."
          : undefined
      }
      style={{
        display: "flex",
        flexDirection: "column",
        color: "inherit",
        ...(posted ? { filter: "grayscale(1)", opacity: 0.55 } : {}),
      }}
    >
      {postedLabel && compact ? (
        <Badge size="xs" variant="filled" color="gray" mb={6}>
          {postedLabel}
        </Badge>
      ) : null}
      {!compact ? (
        <Card.Section p="sm" pb={0} style={{ position: "relative" }}>
          <DealImage
            src={deal.imageUrl}
            alt={deal.title}
            loading={priority ? "eager" : "lazy"}
            fallbackLabel={merchant}
          />
          {hasDiscount ? (
            <Badge
              size="lg"
              color="signal"
              variant="filled"
              className="tnum"
              style={{ position: "absolute", top: 16, left: 16 }}
            >
              {f.discount(deal.discountPercentage as number)}
            </Badge>
          ) : null}
          {postedLabel ? (
            <Badge
              size="sm"
              variant="filled"
              color="dark"
              leftSection={<Icon name="check" size={11} />}
              style={{ position: "absolute", top: 16, right: 16 }}
            >
              {postedLabel}
            </Badge>
          ) : isNew ? (
            <Badge
              size="sm"
              variant="filled"
              color="dark"
              leftSection={<Icon name="bolt" size={11} />}
              style={{ position: "absolute", top: 16, right: 16 }}
            >
              Nouveau
            </Badge>
          ) : isDrop ? (
            <Badge
              size="sm"
              variant="filled"
              color="signal"
              className="tnum"
              style={{ position: "absolute", top: 16, right: 16 }}
            >
              Prix en baisse
              {deal.droppedFrom
                ? ` · était ${f.price(deal.droppedFrom, deal.currency)}`
                : ""}
            </Badge>
          ) : null}
        </Card.Section>
      ) : null}

      <Stack gap={compact ? 6 : 8} mt={compact ? 0 : "sm"} style={{ flex: 1 }}>
        <Text fz="sm" fw={500} lh={1.35} className="clamp-2" title={deal.title}>
          {deal.title}
        </Text>

        <Group gap={8} align="baseline" mt="auto" wrap="wrap">
          <Text fz={compact ? "lg" : "xl"} fw={700} lh={1.1} className="tnum">
            {f.price(deal.currentPrice, deal.currency)}
            {deal.billingPeriod === "month" ? (
              <Text component="span" fz="sm" fw={500} c="dimmed">
                {" "}
                /mois
              </Text>
            ) : null}
          </Text>
          {deal.listPrice && deal.listPrice > deal.currentPrice ? (
            <Text fz="sm" c="dimmed" td="line-through" className="tnum">
              {f.price(deal.listPrice, deal.currency)}
            </Text>
          ) : null}
          {compact && hasDiscount ? (
            <Badge size="sm" color="signal" variant="light" className="tnum">
              {f.discount(deal.discountPercentage as number)}
            </Badge>
          ) : null}
        </Group>

        {saving !== null ? (
          <Text fz="sm" fw={600} c="signal.6" className="tnum">
            Économisez {f.price(saving, deal.currency)}
          </Text>
        ) : (
          // Silence rather than "0 €": we simply never saw a reference price
          // for this merchant, and inventing one would be a lie on a price tag.
          <Text fz="xs" c="dimmed">
            Prix de référence inconnu
          </Text>
        )}

        <Group gap="xs" justify="space-between" wrap="nowrap">
          <Group gap={5} wrap="nowrap" style={{ minWidth: 0 }}>
            <Icon name="store" size={13} aria-hidden />
            <Text fz="xs" c="dimmed" truncate>
              {merchant}
              {deal.sellerName && !deal.soldByMerchant
                ? ` · vendu par ${deal.sellerName}`
                : ""}
            </Text>
            <Tooltip label="Note du deal (prix réel, vendeur, avis)" withArrow>
              <Badge
                size="sm"
                variant="light"
                color={
                  deal.score >= 60
                    ? "teal"
                    : deal.score >= 45
                      ? "yellow"
                      : "gray"
                }
                className="tnum"
                style={{ flexShrink: 0 }}
              >
                {deal.score}/100
              </Badge>
            </Tooltip>
            <HeatBadge chance={deal.hotChance} />
          </Group>
          {seen ? (
            <Tooltip
              label={`${deal.freshReason === "price-drop" ? "Prix en baisse" : "Nouveau"} le ${f.dateTime(freshAt)} · dernière observation : ${f.dateTime(deal.lastSeenAt)}`}
              withArrow
            >
              <Group gap={5} wrap="nowrap">
                <Icon name="clock" size={13} aria-hidden />
                <Text fz="xs" c="dimmed" style={{ whiteSpace: "nowrap" }}>
                  {seen.replace("il y a ", "")}
                </Text>
              </Group>
            </Tooltip>
          ) : null}
        </Group>
      </Stack>
    </Card>
  );
};

export default DealCard;
