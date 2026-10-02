import { AreaChart } from "@mantine/charts";
import {
  Badge,
  Box,
  Button,
  Grid,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { Link } from "alepha/react/router";
import type { FC } from "react";

import DealCard from "../components/deals/DealCard.tsx";
import DealImage from "../components/deals/DealImage.tsx";
import * as f from "../components/ui/format.ts";
import Icon from "../components/ui/Icon.tsx";
import Section from "../components/ui/Section.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import StatTile from "../components/ui/StatTile.tsx";
import type { Deal, RefItem, StatsOverview } from "../types.ts";

export interface DashboardPageProps {
  overview: StatsOverview;
  highlights: {
    bestDiscounts: Deal[];
    newest: Deal[];
    historicalLows: Deal[];
    featured: Deal | null;
  };
  merchants: RefItem[];
}

/**
 * The deal the hero is built around.
 *
 * Shown large because the first screen has to prove the product is worth
 * scrolling: one real offer, priced and quantified, does that better than any
 * amount of copy.
 */
const Featured: FC<{ deal: Deal; merchants: RefItem[] }> = ({
  deal,
  merchants,
}) => {
  const saving = f.savings(deal.currentPrice, deal.listPrice);
  const merchant =
    merchants.find((row) => row.id === deal.merchantId)?.name ??
    f.titleize(deal.merchantId ?? deal.sourceId);

  return (
    <Paper
      component={Link}
      href={`/deals/${deal.id}`}
      p="md"
      className="lift"
      style={{ display: "block", color: "inherit" }}
    >
      <Group align="stretch" wrap="nowrap" gap="md">
        <Box w={130} style={{ flexShrink: 0 }}>
          <DealImage
            src={deal.imageUrl}
            alt={deal.title}
            ratio={1}
            loading="eager"
            fallbackLabel={merchant}
          />
        </Box>
        <Stack gap={6} justify="center" style={{ minWidth: 0 }}>
          <Group gap={6}>
            <Badge size="sm" variant="light" color="gray">
              Coup de cœur
            </Badge>
            {(deal.discountPercentage ?? 0) >= 1 ? (
              <Badge size="sm" color="signal" variant="filled" className="tnum">
                {f.discount(deal.discountPercentage as number)}
              </Badge>
            ) : null}
          </Group>
          <Text fw={600} fz="sm" lh={1.35} className="clamp-2">
            {deal.title}
          </Text>
          <Group gap={8} align="baseline">
            <Text fz="xl" fw={700} className="tnum">
              {f.price(deal.currentPrice, deal.currency)}
            </Text>
            {deal.listPrice && deal.listPrice > deal.currentPrice ? (
              <Text fz="sm" c="dimmed" td="line-through" className="tnum">
                {f.price(deal.listPrice, deal.currency)}
              </Text>
            ) : null}
          </Group>
          {saving !== null ? (
            <Text fz="sm" fw={600} c="signal.6" className="tnum">
              Économisez {f.price(saving, deal.currency)} chez {merchant}
            </Text>
          ) : (
            <Text fz="xs" c="dimmed">
              Chez {merchant}
            </Text>
          )}
        </Stack>
      </Group>
    </Paper>
  );
};

const DashboardPage: FC<DashboardPageProps> = ({
  overview,
  highlights,
  merchants,
}) => {
  const { totals, dealsPerDay, categories } = overview;
  const hasDeals = totals.activeDeals > 0;

  // The chart needs one point per day with a real zero for quiet days;
  // the API already returns the series that way, so this is a pure relabel.
  const series = dealsPerDay.map((point) => ({
    date: f.dayShort(point.date),
    "Nouveaux deals": point.count,
  }));

  if (!hasDeals) {
    return (
      <Stack gap="lg">
        <Title order={1}>Tableau de bord</Title>
        <EmptyState
          icon="inbox"
          title="Aucun bon plan collecté pour l'instant"
          description="Lancez une collecte depuis l'administration : les sources configurées rempliront le catalogue et ce tableau de bord se remplira tout seul."
        >
          <Button
            component={Link}
            href="/admin"
            mt="xs"
            leftSection={<Icon name="play" size={15} />}
          >
            Ouvrir l'administration
          </Button>
        </EmptyState>
      </Stack>
    );
  }

  return (
    <Stack gap="xl">
      {/* Hero */}
      <Paper
        p={{ base: "md", sm: "xl" }}
        radius="lg"
        style={{
          background:
            "linear-gradient(135deg, var(--app-surface), var(--app-surface-muted))",
        }}
      >
        <Grid gap="xl" align="center">
          <Grid.Col span={{ base: 12, md: highlights.featured ? 7 : 12 }}>
            <Stack gap="sm">
              <Badge
                variant="light"
                color="gray"
                leftSection={<Icon name="refresh" size={11} />}
              >
                Mis à jour en continu
              </Badge>
              <Title
                order={1}
                fz={{ base: "1.75rem", sm: "2.25rem" }}
                lh={1.15}
              >
                Les meilleurs bons plans du moment
              </Title>
              <Text c="dimmed" maw={520}>
                {totals.activeDeals} offres suivies en temps réel, avec leur
                historique de prix et la réduction réelle face au prix de
                référence du marchand.
              </Text>
              <Group gap="sm" mt="xs">
                <Button
                  component={Link}
                  href="/deals?sortBy=discount"
                  leftSection={<Icon name="tag" size={16} />}
                >
                  Parcourir les offres
                </Button>
                <Button
                  component={Link}
                  href="/stats"
                  variant="default"
                  leftSection={<Icon name="chart" size={16} />}
                >
                  Voir les statistiques
                </Button>
              </Group>
            </Stack>
          </Grid.Col>
          {highlights.featured ? (
            <Grid.Col span={{ base: 12, md: 5 }}>
              <Featured deal={highlights.featured} merchants={merchants} />
            </Grid.Col>
          ) : null}
        </Grid>
      </Paper>

      {/* Headline figures. Four, not twelve: the rest lives on /stats. */}
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile
          label="Offres actives"
          value={totals.activeDeals}
          icon="tag"
          hint={`${totals.newLast7d} sur les 7 derniers jours`}
        />
        <StatTile
          label="Nouveautés (24 h)"
          value={totals.newLast24h}
          icon="bolt"
        />
        <StatTile
          label="Meilleure réduction"
          value={
            totals.bestDiscount === null ? "" : f.discount(totals.bestDiscount)
          }
          empty={totals.bestDiscount === null}
          accent
          icon="flame"
          hint="Aucun prix de référence relevé pour l'instant"
        />
        <StatTile
          label="Économies cumulées"
          value={f.priceCompact(totals.potentialSavings)}
          icon="trendingDown"
          hint={`Sur ${totals.dealsWithDiscount} offres remisées`}
        />
      </SimpleGrid>

      {highlights.bestDiscounts.length > 0 ? (
        <Section
          title="Meilleures réductions"
          description="Les plus gros écarts avec le prix de référence du marchand."
          moreHref="/deals?sortBy=discount"
        >
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
            {highlights.bestDiscounts.slice(0, 4).map((deal, index) => (
              <DealCard
                key={deal.id}
                deal={deal}
                merchants={merchants}
                priority={index < 4}
              />
            ))}
          </SimpleGrid>
        </Section>
      ) : null}

      {highlights.historicalLows.length > 0 ? (
        <Section
          title="Au plus bas jamais observé"
          description="Prix actuel au niveau du minimum relevé depuis le début du suivi."
          moreHref="/deals?sortBy=relevance"
        >
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
            {highlights.historicalLows.slice(0, 4).map((deal) => (
              <DealCard key={deal.id} deal={deal} merchants={merchants} />
            ))}
          </SimpleGrid>
        </Section>
      ) : null}

      {highlights.newest.length > 0 ? (
        <Section
          title="Dernières détections"
          description="Les offres repérées le plus récemment par les collecteurs."
          moreHref="/deals?sortBy=newest"
        >
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
            {highlights.newest.slice(0, 4).map((deal) => (
              <DealCard key={deal.id} deal={deal} merchants={merchants} />
            ))}
          </SimpleGrid>
        </Section>
      ) : null}

      <Grid gap="md">
        <Grid.Col span={{ base: 12, md: 8 }}>
          <Section
            title="Rythme de collecte"
            description="Nouvelles offres détectées par jour, sur 14 jours."
          >
            <Paper p="md">
              {series.length > 1 ? (
                <AreaChart
                  h={220}
                  data={series}
                  dataKey="date"
                  series={[{ name: "Nouveaux deals", color: "signal.5" }]}
                  curveType="monotone"
                  withDots={false}
                  gridAxis="y"
                  tickLine="none"
                  withYAxis
                  valueFormatter={(value) => String(value)}
                />
              ) : (
                <Text fz="sm" c="dimmed" py="xl" ta="center">
                  L'historique commence à la première collecte : revenez dans
                  quelques jours pour voir une tendance.
                </Text>
              )}
            </Paper>
          </Section>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 4 }}>
          <Section
            title="Catégories"
            description="Répartition des offres actives."
          >
            <Paper p="md" h="100%">
              <Stack gap="sm">
                {categories.slice(0, 6).map((row) => {
                  const share = Math.round(
                    (row.count / Math.max(totals.activeDeals, 1)) * 100,
                  );
                  return (
                    <Box key={row.id}>
                      <Group justify="space-between" gap="xs" mb={4}>
                        <Text
                          fz="sm"
                          component={Link}
                          href={`/deals?categoryId=${row.id}`}
                          style={{ color: "inherit", textDecoration: "none" }}
                        >
                          {row.name}
                        </Text>
                        <Text fz="sm" c="dimmed" className="tnum">
                          {row.count}
                        </Text>
                      </Group>
                      <Box
                        h={6}
                        style={{
                          borderRadius: 3,
                          background: "var(--app-surface-muted)",
                        }}
                      >
                        <Box
                          h={6}
                          w={`${Math.max(share, 2)}%`}
                          style={{
                            borderRadius: 3,
                            background: "var(--mantine-primary-color-filled)",
                          }}
                        />
                      </Box>
                    </Box>
                  );
                })}
                {categories.length === 0 ? (
                  <Text fz="sm" c="dimmed">
                    Aucune catégorie attribuée pour l'instant.
                  </Text>
                ) : null}
              </Stack>
            </Paper>
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

export default DashboardPage;
