import { LineChart } from "@mantine/charts";
import {
  Anchor,
  Badge,
  Group,
  Loader,
  Paper,
  Stack,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, useEffect, useMemo, useState } from "react";

import type { DealsController } from "../../../api/controllers/DealsController.ts";
import type { Deal, ExternalPriceHistory } from "../../types.ts";
import * as f from "../ui/format.ts";

export interface PriceHistoryPanelProps {
  deal: Deal;
}

/**
 * "How much has this product cost before?" from outside sources: the
 * prices it was already posted at on Dealabs (every product), and the
 * Steam price curve from IsThereAnyDeal (games, when configured).
 *
 * One chart per source — both are euros, but they are different things
 * (community deal prices vs a store's price over time) and mixing them on
 * one line would read as one series. Today's price is a reference line on
 * each, and the past deals are also listed in a table, so nothing depends
 * on reading the chart.
 */
const PriceHistoryPanel: FC<PriceHistoryPanelProps> = ({ deal }) => {
  const deals = useClient<DealsController>();
  const [data, setData] = useState<ExternalPriceHistory | null | undefined>(
    undefined,
  );

  useEffect(() => {
    let cancelled = false;
    deals
      .priceHistory({ params: { id: deal.id } })
      .then((result) => {
        if (!cancelled) setData(result as ExternalPriceHistory);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [deal.id, deals]);

  const pastDeals = useMemo(
    () =>
      (data?.dealabs ?? []).map((past) => ({
        date: f.dayShort(past.publishedAt),
        "Prix du bon plan": past.price,
      })),
    [data],
  );
  const steam = useMemo(
    () =>
      (data?.steam ?? []).map((point) => ({
        date: f.dayShort(point.date),
        "Prix Steam": point.price,
      })),
    [data],
  );

  const domainFor = (values: number[]): [number, number] => {
    const all = [...values, deal.currentPrice];
    const min = Math.min(...all);
    const max = Math.max(...all);
    const padding = Math.max((max - min) * 0.1, 1);
    return [Math.max(0, min - padding), max + padding];
  };

  const todayLine = {
    y: deal.currentPrice,
    label: `Aujourd'hui ${f.price(deal.currentPrice, deal.currency)}`,
    color: "var(--mantine-color-dimmed)",
  };

  if (data === undefined) {
    return (
      <Paper p="md">
        <Group gap="xs">
          <Loader size="xs" />
          <Text fz="sm" c="dimmed">
            Chargement de l'historique des bons plans…
          </Text>
        </Group>
      </Paper>
    );
  }

  const hasDealabs = (data?.dealabs.length ?? 0) > 0;
  const hasSteam = (data?.steam.length ?? 0) > 1;

  return (
    <Stack gap="sm">
      <Paper p="md">
        <Stack gap={2} mb="sm">
          <Title order={5}>Prix des bons plans déjà postés sur Dealabs</Title>
          <Text fz="sm" c="dimmed">
            {hasDealabs
              ? `${data?.dealabs.length} bon${(data?.dealabs.length ?? 0) > 1 ? "s" : ""} plan${(data?.dealabs.length ?? 0) > 1 ? "s" : ""} trouvé${(data?.dealabs.length ?? 0) > 1 ? "s" : ""} pour ce produit : ce que la communauté a déjà payé.`
              : deal.dealabsCheckedAt
                ? "Aucun bon plan passé trouvé pour ce produit sur Dealabs."
                : "Pas encore vérifié : la recherche se fait lors des prochaines collectes."}
          </Text>
        </Stack>

        {pastDeals.length > 1 ? (
          <LineChart
            h={220}
            data={pastDeals}
            dataKey="date"
            series={[{ name: "Prix du bon plan", color: "signal.5" }]}
            curveType="linear"
            gridAxis="y"
            tickLine="none"
            withDots
            yAxisProps={{
              domain: domainFor(data?.dealabs.map((d) => d.price) ?? []),
            }}
            valueFormatter={(value) => f.price(value, deal.currency)}
            referenceLines={[todayLine]}
          />
        ) : null}

        {hasDealabs ? (
          <Table.ScrollContainer minWidth={480} mt="sm">
            <Table fz="sm" verticalSpacing={4}>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Date</Table.Th>
                  <Table.Th>Prix</Table.Th>
                  <Table.Th>Température</Table.Th>
                  <Table.Th>Marchand</Table.Th>
                  <Table.Th />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {[...(data?.dealabs ?? [])].reverse().map((past) => (
                  <Table.Tr key={past.url}>
                    <Table.Td>{f.date(past.publishedAt)}</Table.Td>
                    <Table.Td className="tnum">
                      {f.price(past.price, deal.currency)}
                    </Table.Td>
                    <Table.Td className="tnum">
                      {past.temperature}°{" "}
                      {past.isHot ? (
                        <Badge size="xs" variant="light" color="orange">
                          Hot
                        </Badge>
                      ) : null}
                    </Table.Td>
                    <Table.Td>{past.merchant ?? "—"}</Table.Td>
                    <Table.Td>
                      <Anchor
                        href={past.url}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        fz="xs"
                      >
                        Voir
                      </Anchor>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        ) : null}
      </Paper>

      {hasSteam ? (
        <Paper p="md">
          <Stack gap={2} mb="sm">
            <Title order={5}>Prix Steam sur deux ans</Title>
            <Text fz="sm" c="dimmed">
              Source : IsThereAnyDeal.
              {deal.historicalLowPrice
                ? ` Plus bas historique : ${f.price(deal.historicalLowPrice, deal.currency)}${deal.historicalLowAt ? ` (${f.date(deal.historicalLowAt)})` : ""}.`
                : ""}
            </Text>
          </Stack>
          <LineChart
            h={220}
            data={steam}
            dataKey="date"
            series={[{ name: "Prix Steam", color: "signal.5" }]}
            curveType="stepAfter"
            gridAxis="y"
            tickLine="none"
            withDots={steam.length < 30}
            yAxisProps={{
              domain: domainFor(data?.steam.map((p) => p.price) ?? []),
            }}
            valueFormatter={(value) => f.price(value, deal.currency)}
            referenceLines={[todayLine]}
          />
        </Paper>
      ) : null}
    </Stack>
  );
};

export default PriceHistoryPanel;
