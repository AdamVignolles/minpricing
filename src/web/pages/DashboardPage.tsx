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
import { type FC, useState } from "react";

import type { RoutineHealth } from "../../api/services/agentHealth.ts";
import type { PublishPause } from "../../api/services/PublishPauseService.ts";
import type { ScheduleEntry } from "../../api/services/PublishScheduleService.ts";
import { PublishPauseSwitch } from "../components/agents/PublishControls.tsx";
import SystemStatus, {
  type CollectionState,
  type DealabsSession,
} from "../components/dashboard/SystemStatus.tsx";
import DealCard from "../components/deals/DealCard.tsx";
import AddLinkField from "../components/links/AddLinkField.tsx";
import * as f from "../components/ui/format.ts";
import Icon from "../components/ui/Icon.tsx";
import Section from "../components/ui/Section.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import StatTile from "../components/ui/StatTile.tsx";
import { useNow } from "../components/ui/useNow.ts";
import type {
  Deal,
  PublicationStats,
  RefItem,
  StatsOverview,
} from "../types.ts";

export interface DashboardPageProps {
  overview: StatsOverview;
  highlights: {
    bestDiscounts: Deal[];
    newest: Deal[];
    historicalLows: Deal[];
    featured: Deal | null;
  };
  merchants: RefItem[];
  publications: PublicationStats;
  /** Best Dealabs potential, not on Dealabs yet. */
  toPublish: Deal[];
  session?: DealabsSession;
  collection?: CollectionState;
  routines?: RoutineHealth[];
  tonight?: ScheduleEntry[];
  /** Automatic publishing paused by hand; unknown when unreadable. */
  pause?: PublishPause;
}

const DashboardPage: FC<DashboardPageProps> = ({
  overview,
  highlights,
  merchants,
  publications,
  toPublish,
  session,
  collection,
  routines,
  tonight,
  pause: initialPause,
}) => {
  const [pause, setPause] = useState(initialPause);
  const { totals, dealsPerDay, categories } = overview;
  const hasDeals = totals.activeDeals > 0;
  const now = useNow();

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
      <Group justify="space-between" align="flex-end" gap="sm">
        <Stack gap={2}>
          <Title order={1}>Tableau de bord</Title>
          <Text c="dimmed" fz="sm">
            {now
              ? `${new Date(now).toLocaleDateString("fr-FR", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                  timeZone: "Europe/Paris",
                })} · `
              : null}
            {totals.activeDeals} offres suivies, {totals.newLast24h} nouvelles
            en 24 h
          </Text>
        </Stack>
        <Group gap="sm">
          <Button
            component={Link}
            href="/deals?sortBy=hot"
            leftSection={<Icon name="flame" size={16} />}
          >
            Potentiel Dealabs
          </Button>
          <Button
            component={Link}
            href="/agents"
            variant="default"
            leftSection={<Icon name="clock" size={16} />}
          >
            Agents
          </Button>
        </Group>
      </Group>

      <AddLinkField />

      {pause ? <PublishPauseSwitch pause={pause} onChange={setPause} /> : null}

      <SystemStatus
        paused={pause?.paused}
        session={session}
        collection={collection}
        routines={routines}
        tonight={tonight}
      />

      {toPublish.length > 0 ? (
        <Section
          title="À publier en priorité"
          description="Meilleure chance d'atteindre 100° sur Dealabs, et pas encore postés."
          moreHref="/deals?sortBy=hot"
        >
          <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="md">
            {toPublish.map((deal, index) => (
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

      {/* Headline figures. Four, not twelve: the rest lives on /stats. */}
      <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
        <StatTile
          label="Offres actives"
          value={totals.activeDeals}
          icon="package"
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

      <Section
        title="Résultats de nos publications"
        description="Ce que nos posts Dealabs ont donné."
      >
        <SimpleGrid cols={{ base: 2, md: 4 }} spacing="md">
          <StatTile
            label="Deals publiés"
            value={publications.posted}
            icon="package"
            hint={`${publications.postedLast7d} sur les 7 derniers jours`}
          />
          <StatTile
            label="Température moyenne"
            value={
              publications.averageTemperature === null
                ? ""
                : `${publications.averageTemperature}°`
            }
            empty={publications.averageTemperature === null}
            icon="flame"
            hint="Posts lus sur notre profil Dealabs (DEALABS_USERNAME)"
          />
          <StatTile
            label="Deals « hot »"
            value={`${publications.hotPosts} / ${publications.totalPosts}`}
            icon="bolt"
            hint="Posts ayant atteint la température « hot »"
          />
          <StatTile
            label="Brouillons en attente"
            value={publications.pendingDrafts}
            icon="package"
            hint={
              publications.failedAttempts > 0
                ? `${publications.failedAttempts} publication(s) échouée(s)`
                : publications.lastPostedAt
                  ? `Dernier post le ${f.date(publications.lastPostedAt)}`
                  : undefined
            }
          />
        </SimpleGrid>
        {publications.bestPosts.length > 0 ? (
          <Paper p="md">
            <Stack gap="xs">
              <Text fw={600}>Nos meilleurs posts</Text>
              {publications.bestPosts.map((post) => (
                <Group
                  key={post.id}
                  justify="space-between"
                  wrap="nowrap"
                  gap="sm"
                >
                  <Text
                    component="a"
                    href={post.url}
                    target="_blank"
                    rel="noreferrer"
                    fz="sm"
                    lineClamp={1}
                    style={{ minWidth: 0 }}
                  >
                    {post.title}
                  </Text>
                  <Badge color="orange" variant="light">
                    {post.temperature}°
                  </Badge>
                </Group>
              ))}
            </Stack>
          </Paper>
        ) : null}
      </Section>

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
