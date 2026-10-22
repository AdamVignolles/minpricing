import { LineChart } from "@mantine/charts";
import { Anchor, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, useEffect, useMemo, useState } from "react";

import type { DealsController } from "../../../api/controllers/DealsController.ts";
import type { Deal } from "../../types.ts";
import * as f from "../ui/format.ts";
import { useNow } from "../ui/useNow.ts";

interface StoreHistory {
  source: string;
  url: string;
  points: Array<{ at: string; price: number }>;
}

/** Two years: enough to see the store's usual sale prices. */
const WINDOW_DAYS = 730;

/**
 * The store's own price over time for deals Keepa can't chart (Nintendo
 * eShop, via DekuDeals) — the non-Amazon counterpart of `KeepaChart`.
 * Renders nothing when no source covers the product.
 */
const StoreHistoryChart: FC<{ deal: Deal }> = ({ deal }) => {
  const deals = useClient<DealsController>();
  const [history, setHistory] = useState<StoreHistory | null>(null);
  const now = useNow();

  useEffect(() => {
    let cancelled = false;
    deals
      .externalHistory({ params: { id: deal.id } })
      .then((result) => {
        if (!cancelled) setHistory(result as StoreHistory | null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [deal.id, deals]);

  const { data, low } = useMemo(() => {
    if (!history) return { data: [], low: undefined };
    const since = new Date(now - WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const before = history.points.filter((p) => p.at < since).pop();
    const points = [
      ...(before ? [{ at: since, price: before.price }] : []),
      ...history.points.filter((p) => p.at >= since),
    ];
    if (points.length) {
      points.push({
        at: new Date(now).toISOString().slice(0, 10),
        price: points[points.length - 1].price,
      });
    }
    const lowest = points.reduce<{ at: string; price: number } | undefined>(
      (best, p) => (!best || p.price < best.price ? p : best),
      undefined,
    );
    return {
      data: points.map((p) => ({ date: f.dayShort(p.at), Prix: p.price })),
      low: lowest,
    };
  }, [history, now]);

  if (!history || data.length < 2) return null;

  return (
    <Paper p="md" withBorder>
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Title order={5}>Historique du prix ({history.source})</Title>
          <Anchor href={history.url} target="_blank" rel="noreferrer" fz="xs">
            Historique complet
          </Anchor>
        </Group>
        <LineChart
          h={220}
          data={data}
          dataKey="date"
          series={[{ name: "Prix", color: "blue.6" }]}
          curveType="stepAfter"
          gridAxis="y"
          tickLine="none"
          withDots={false}
          valueFormatter={(value) => f.price(value, deal.currency)}
          referenceLines={[
            {
              y: deal.currentPrice,
              label: `Aujourd'hui ${f.price(deal.currentPrice, deal.currency)}`,
              color: "var(--mantine-color-dimmed)",
            },
          ]}
        />
        {low ? (
          <Text fz="xs" c="dimmed">
            Plus bas sur deux ans : {f.price(low.price, deal.currency)} (
            {f.dayShort(low.at)}).{" "}
            {deal.currentPrice <= low.price
              ? "Le prix actuel l'égale ou le bat."
              : ""}{" "}
            Ajouté en tête de la description lors de la publication sur Dealabs.
          </Text>
        ) : null}
      </Stack>
    </Paper>
  );
};

export default StoreHistoryChart;
