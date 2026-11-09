import { Badge, Paper, SimpleGrid, Stack, Text } from "@mantine/core";
import type { FC, ReactNode } from "react";

import type { Deal, Draft, PriceStats, RefItem } from "../../types.ts";
import * as f from "../ui/format.ts";
import { REFERENCE_SHORT, reviewsLine, sellerLine } from "./dealSignals.ts";
import { HEAT, heatLabel } from "./HeatForecast.tsx";

interface PastThread {
  title: string;
  price: number;
  publishedAt: string;
  temperature: number;
  isExpired: boolean;
  mine?: boolean;
}

type Tone = "good" | "warn" | "bad" | "info" | "neutral";

const TONE_COLOR: Record<Tone, string> = {
  good: "var(--mantine-color-teal-6)",
  warn: "var(--mantine-color-orange-6)",
  bad: "var(--mantine-color-red-6)",
  info: "var(--mantine-color-blue-6)",
  neutral: "var(--mantine-color-default-border)",
};

const Tile: FC<{
  label: string;
  tone: Tone;
  headline: ReactNode;
  children?: ReactNode;
}> = ({ label, tone, headline, children }) => (
  <Paper p="sm" style={{ borderTop: `3px solid ${TONE_COLOR[tone]}` }}>
    <Stack gap={4}>
      <Text
        fz="xs"
        fw={600}
        c="dimmed"
        style={{ textTransform: "uppercase", letterSpacing: "0.06em" }}
      >
        {label}
      </Text>
      <Text fw={700} lh={1.3}>
        {headline}
      </Text>
      {children ? (
        <Text fz="sm" c="dimmed" lh={1.4}>
          {children}
        </Text>
      ) : null}
    </Stack>
  </Paper>
);

const parseThreads = (raw?: string): PastThread[] => {
  try {
    return raw ? (JSON.parse(raw) as PastThread[]) : [];
  } catch {
    return [];
  }
};

/**
 * The deal page's answer to « faut-il le poster ? » (epic 30, design A):
 * the four things read first, one box each — the price and its real drop,
 * the product on Dealabs, its chances there, the seller and reviews. Every
 * figure comes from the score's own analysis or the stored rows; a missing
 * one says so.
 */
const DealVerdict: FC<{
  deal: Deal;
  stats: PriceStats;
  draft: Draft | null;
  merchants: RefItem[];
}> = ({ deal, stats, draft, merchants }) => {
  const { reference, bestAlternative } = stats.analysis;
  const cur = deal.currency;

  // Price.
  let priceTone: Tone = "neutral";
  let priceHead: ReactNode = "Pas de référence de prix";
  const priceLines: string[] = [];
  if (deal.currentPrice === 0) {
    priceTone = "good";
    priceHead = "Gratuit";
  } else if (reference) {
    const trusted = reference.kind !== "rrp" && reference.kind !== "listed";
    priceTone =
      reference.discountPercentage >= 20 && trusted
        ? "good"
        : reference.discountPercentage > 0
          ? "neutral"
          : "warn";
    priceHead = (
      <>
        <Text component="span" fw={700} c={trusted ? "signal" : undefined}>
          {reference.discountPercentage > 0
            ? f.discount(reference.discountPercentage)
            : "Pas de baisse"}
        </Text>{" "}
        vs {REFERENCE_SHORT[reference.kind] ?? reference.label}
      </>
    );
    priceLines.push(
      `${reference.label.charAt(0).toUpperCase()}${reference.label.slice(1)} : ${f.price(reference.price, cur)}${trusted ? "" : " (indicatif)"}.`,
    );
  }
  if (bestAlternative) {
    priceLines.push(
      bestAlternative.price < deal.currentPrice
        ? `Moins cher chez ${bestAlternative.label} : ${f.price(bestAlternative.price, cur)}.`
        : `${bestAlternative.label} : ${f.price(bestAlternative.price, cur)}.`,
    );
    if (bestAlternative.price < deal.currentPrice * 0.97) priceTone = "warn";
  }
  if (stats.isNewHistoricalMin && stats.historyPoints > 1) {
    priceLines.push(
      `Plus bas relevé par nous (${stats.historyPoints} relevés).`,
    );
  }

  // Dealabs.
  const threads = parseThreads(deal.dealabsHistory).sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  );
  const ours = threads.find((t) => t.mine && !t.isExpired);
  const othersLive = threads.find((t) => !t.mine && !t.isExpired);
  const status = draft?.dealabsStatus;
  let dlTone: Tone = "good";
  let dlHead: ReactNode = "Jamais posté";
  const dlLines: string[] = [];
  if (status === "hidden" || status === "deleted") {
    dlTone = "bad";
    dlHead =
      status === "hidden"
        ? "Votre post est masqué"
        : "Votre post a été supprimé";
  } else if (status === "live" || status === "expired" || ours) {
    dlTone = status === "expired" ? "neutral" : "warn";
    dlHead =
      status === "expired" ? "Votre post a expiré" : "Votre post est en ligne";
    const post = ours ?? threads.find((t) => t.mine);
    if (post) {
      dlLines.push(
        `Le ${f.date(post.publishedAt)} à ${f.price(post.price, cur)} · ${post.temperature}°.`,
      );
    }
  } else if (othersLive) {
    dlTone = "warn";
    dlHead = `Déjà en ligne à ${f.price(othersLive.price, cur)}`;
    dlLines.push(
      `Posté par un autre membre le ${f.date(othersLive.publishedAt)} · ${othersLive.temperature}°.`,
    );
  } else if (threads.length > 0) {
    dlTone = "info";
    dlHead = `Posté ${threads.length} fois, rien en ligne`;
  }
  const best = threads
    .filter((t) => !t.mine)
    .sort((a, b) => a.price - b.price)[0];
  if (best && best !== othersLive) {
    dlLines.push(
      `Plus bas posté : ${f.price(best.price, cur)} le ${f.date(best.publishedAt)} (${best.temperature}°).`,
    );
  }

  // Chances.
  const chance = stats.heat?.chance ?? deal.hotChance;
  const tier = chance !== undefined ? HEAT[heatLabel(chance)] : undefined;

  return (
    <SimpleGrid cols={{ base: 1, xs: 2, lg: 4 }} spacing="sm">
      <Tile label="Prix" tone={priceTone} headline={priceHead}>
        {priceLines.join(" ")}
      </Tile>
      <Tile label="Dealabs" tone={dlTone} headline={dlHead}>
        {dlLines.join(" ")}
      </Tile>
      <Tile
        label="Potentiel"
        tone="info"
        headline={
          chance !== undefined ? (
            <>
              {chance} % de chances de 100°{" "}
              {tier ? (
                <Badge size="xs" variant="light" color={tier.color} ml={4}>
                  {tier.label}
                </Badge>
              ) : null}
            </>
          ) : (
            "Pas d'estimation"
          )
        }
      >
        {`Note ${stats.analysis.score}/100.${stats.heat?.reasons?.length ? ` ${stats.heat.reasons.join(" ")}` : ""}`}
      </Tile>
      <Tile
        label="Vendeur et avis"
        tone={
          deal.soldByMerchant
            ? "good"
            : deal.productRating
              ? "neutral"
              : "neutral"
        }
        headline={sellerLine(deal, merchants)}
      >
        {`${reviewsLine(deal)}${deal.recentPurchases ? ` · ${deal.recentPurchases}+ achats le mois dernier` : ""}${deal.offersCount ? ` · ${deal.offersCount} offres` : ""}.`}
      </Tile>
    </SimpleGrid>
  );
};

export default DealVerdict;
