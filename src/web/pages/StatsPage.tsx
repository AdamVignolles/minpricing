import { AreaChart, BarChart, DonutChart } from "@mantine/charts";
import { Grid, Paper, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import type { FC } from "react";

import * as f from "../components/ui/format.ts";
import Section from "../components/ui/Section.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import StatTile from "../components/ui/StatTile.tsx";
import type { StatsOverview } from "../types.ts";

export interface StatsPageProps {
  overview: StatsOverview;
}

/** Donut slices. Neutral greys, with the accent reserved for the leader. */
const SLICE_COLORS = [
  "signal.5",
  "blue.5",
  "violet.5",
  "teal.5",
  "orange.5",
  "pink.5",
  "gray.5",
];

/**
 * Wraps a chart so an empty dataset never renders as an axis with nothing
 * on it — which reads as a broken component rather than as "no data yet".
 */
const Chart: FC<{
  empty: boolean;
  message: string;
  children: React.ReactNode;
}> = ({ empty, message, children }) => (
  <Paper p="md" h="100%">
    {empty ? (
      <Text fz="sm" c="dimmed" ta="center" py="xl">
        {message}
      </Text>
    ) : (
      children
    )}
  </Paper>
);

const StatsPage: FC<StatsPageProps> = ({ overview }) => {
  const { totals, categories, merchants, discountBuckets, dealsPerDay } =
    overview;

  if (totals.activeDeals === 0 && totals.expiredDeals === 0) {
    return (
      <Stack gap="lg">
        <Title order={1} fz="1.75rem">
          Statistiques
        </Title>
        <EmptyState
          icon="chart"
          title="Rien à mesurer pour l'instant"
          description="Les statistiques se construisent à partir des offres collectées. Lancez une première collecte depuis l'administration."
        />
      </Stack>
    );
  }

  const perDay = dealsPerDay.map((point) => ({
    date: f.dayShort(point.date),
    "Nouveaux deals": point.count,
  }));

  const buckets = discountBuckets.map((bucket) => ({
    bucket: bucket.label,
    Offres: bucket.count,
  }));

  const categoryBars = categories.slice(0, 8).map((row) => ({
    name: row.name,
    Offres: row.count,
  }));

  const merchantSlices = merchants.slice(0, 7).map((row, index) => ({
    name: row.name,
    value: row.count,
    color: SLICE_COLORS[index % SLICE_COLORS.length],
  }));

  return (
    <Stack gap="xl">
      <Stack gap={2}>
        <Title order={1} fz="1.75rem">
          Statistiques
        </Title>
        <Text fz="sm" c="dimmed">
          Toutes les valeurs sont calculées sur les offres réellement collectées
          — aucune projection ni estimation.
        </Text>
      </Stack>

      <SimpleGrid cols={{ base: 2, md: 3, lg: 6 }} spacing="md">
        <StatTile
          label="Offres actives"
          value={totals.activeDeals}
          icon="tag"
        />
        <StatTile
          label="Offres expirées"
          value={totals.expiredDeals}
          icon="clock"
        />
        <StatTile
          label="Offres remisées"
          value={totals.dealsWithDiscount}
          icon="flame"
          hint={`sur ${totals.activeDeals} actives`}
        />
        <StatTile
          label="Réduction moyenne"
          value={
            totals.averageDiscount === null
              ? ""
              : f.discount(totals.averageDiscount)
          }
          empty={totals.averageDiscount === null}
          hint="Aucun prix de référence relevé"
          accent
          icon="trendingDown"
        />
        <StatTile
          label="Prix moyen"
          value={
            totals.averagePrice === null ? "" : f.price(totals.averagePrice)
          }
          empty={totals.averagePrice === null}
          icon="package"
        />
        <StatTile
          label="Économies cumulées"
          value={f.priceCompact(totals.potentialSavings)}
          icon="tag"
        />
      </SimpleGrid>

      <Grid gap="md">
        <Grid.Col span={{ base: 12, lg: 8 }}>
          <Section
            title="Nouvelles offres par jour"
            description="Mesure le rythme réel des collecteurs : un creux signale en général une source en échec."
          >
            <Chart
              empty={perDay.length < 2}
              message="L'historique démarre à la première collecte ; il faut au moins deux jours pour dessiner une tendance."
            >
              <AreaChart
                h={260}
                data={perDay}
                dataKey="date"
                series={[{ name: "Nouveaux deals", color: "signal.5" }]}
                curveType="monotone"
                withDots={false}
                gridAxis="xy"
                tickLine="none"
              />
            </Chart>
          </Section>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 4 }}>
          <Section
            title="Marchands"
            description="Où se concentrent les offres actives."
          >
            <Chart
              empty={merchantSlices.length === 0}
              message="Aucun marchand associé aux offres pour l'instant."
            >
              <Stack align="center" gap="sm">
                <DonutChart
                  h={220}
                  data={merchantSlices}
                  withLabelsLine={false}
                  paddingAngle={2}
                  thickness={26}
                  chartLabel={`${totals.activeDeals} offres`}
                  tooltipDataSource="segment"
                />
              </Stack>
            </Chart>
          </Section>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Section
            title="Répartition des réductions"
            description="Combien d'offres par palier de remise — indique si le catalogue contient de vraies affaires ou surtout du bruit."
          >
            <Chart
              empty={buckets.every((bucket) => bucket.Offres === 0)}
              message="Aucune réduction mesurable : les prix de référence manquent encore."
            >
              <BarChart
                h={260}
                data={buckets}
                dataKey="bucket"
                series={[{ name: "Offres", color: "signal.5" }]}
                gridAxis="y"
                tickLine="none"
                barProps={{ radius: [4, 4, 0, 0] }}
              />
            </Chart>
          </Section>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 6 }}>
          <Section
            title="Catégories"
            description="Les familles de produits les plus représentées."
          >
            <Chart
              empty={categoryBars.length === 0}
              message="Aucune catégorie attribuée pour l'instant."
            >
              <BarChart
                h={260}
                data={categoryBars}
                dataKey="name"
                orientation="vertical"
                series={[{ name: "Offres", color: "blue.5" }]}
                gridAxis="x"
                tickLine="none"
                yAxisProps={{ width: 110 }}
                barProps={{ radius: [0, 4, 4, 0] }}
              />
            </Chart>
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

export default StatsPage;
