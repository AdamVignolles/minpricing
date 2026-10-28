import { BarChart } from "@mantine/charts";
import {
  Anchor,
  Badge,
  Grid,
  Group,
  Paper,
  Progress,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Table,
  Tabs,
  Text,
  ThemeIcon,
  Timeline,
  Title,
  Tooltip,
} from "@mantine/core";
import { Link } from "alepha/react/router";
import { type FC, useMemo, useState } from "react";

import type {
  AgentReportSummary,
  AgentsService,
  WeightRow,
} from "../../api/services/AgentsService.ts";
import TonightPlan, {
  type TonightPlanData,
} from "../components/agents/TonightPlan.tsx";
import * as f from "../components/ui/format.ts";
import Icon from "../components/ui/Icon.tsx";
import Markdown from "../components/ui/Markdown.tsx";
import Section from "../components/ui/Section.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import StatTile from "../components/ui/StatTile.tsx";
import type { RefItem } from "../types.ts";

type Overview = ReturnType<AgentsService["overview"]>;

export interface AgentsPageProps {
  overview: Overview;
  reports: AgentReportSummary[];
  report?: { id: string; markdown: string };
  categories: RefItem[];
  tonight: TonightPlanData;
  tab?: string;
}

const REPORT_TYPES: Record<
  AgentReportSummary["type"],
  { label: string; color: string; icon: string }
> = {
  soiree: { label: "Soirée", color: "blue", icon: "🌆" },
  debrief: { label: "Debrief", color: "pink", icon: "🧠" },
  sources: { label: "Sources", color: "yellow", icon: "🔎" },
  bilan: { label: "Bilan hebdo", color: "violet", icon: "📊" },
  autre: { label: "Rapport", color: "gray", icon: "📄" },
};

const RESULT: Record<string, { label: string; color: string }> = {
  success: { label: "Publié", color: "teal" },
  unavailable: { label: "Ignoré", color: "gray" },
  skipped: { label: "Ignoré", color: "gray" },
  duplicate: { label: "Doublon", color: "orange" },
  failed: { label: "Échec", color: "red" },
};

const DAYS = ["", "lun", "mar", "mer", "jeu", "ven", "sam", "dim"];

/** Next evening run: 17:00 on a publishing day. */
function nextRun(publishDays: number[]): string {
  const next = new Date();
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(next);
    candidate.setDate(next.getDate() + i);
    candidate.setHours(17, 0, 0, 0);
    const weekday = candidate.getDay() === 0 ? 7 : candidate.getDay();
    if (candidate > new Date() && publishDays.includes(weekday)) {
      return i === 0
        ? "Aujourd'hui 17:00"
        : i === 1
          ? "Demain 17:00"
          : `${candidate.toLocaleDateString("fr-FR", { weekday: "long" })} 17:00`;
    }
  }
  return "—";
}

const TemperatureBadge: FC<{ value?: number }> = ({ value }) => {
  if (value === undefined)
    return (
      <Text fz="xs" c="dimmed">
        —
      </Text>
    );
  const color =
    value >= 100
      ? "orange"
      : value >= 50
        ? "yellow"
        : value < 0
          ? "blue"
          : "gray";
  return (
    <Badge
      color={color}
      variant={value >= 100 ? "filled" : "light"}
      leftSection={value >= 100 ? <Icon name="flame" size={12} /> : null}
    >
      {value}°
    </Badge>
  );
};

/**
 * Diverging bars: green favours, red holds back. Weights are not prices,
 * so the price accent (signal) is deliberately not used here.
 */
const WeightChart: FC<{
  rows: WeightRow[];
  label: (key: string) => string;
  unit: string;
  empty: string;
}> = ({ rows, label, unit, empty }) =>
  rows.length === 0 ? (
    <Text fz="sm" c="dimmed" ta="center" py="lg">
      {empty}
    </Text>
  ) : (
    <BarChart
      h={Math.max(120, rows.length * 30 + 40)}
      data={rows.map((row) => ({ name: label(row.key), Poids: row.value }))}
      dataKey="name"
      orientation="vertical"
      yAxisProps={{ width: 130 }}
      series={[{ name: "Poids", color: "teal.6" }]}
      getBarColor={(value) => (value >= 0 ? "teal.6" : "red.6")}
      valueFormatter={(value) => `${value > 0 ? "+" : ""}${value}${unit}`}
      gridAxis="x"
      withTooltip
    />
  );

const AgentsPage: FC<AgentsPageProps> = ({
  overview,
  reports,
  report,
  categories,
  tonight,
  tab,
}) => {
  const [reportFilter, setReportFilter] = useState<string>("all");
  const categoryName = useMemo(() => {
    const names = new Map(categories.map((c) => [c.id, c.name]));
    return (id: string) => names.get(id) ?? f.titleize(id.replace(/-/g, " "));
  }, [categories]);
  const { kpis, rules, desirability, collection } = overview;

  if (kpis.attempted14d === 0 && reports.length === 0 && rules.version === 0) {
    return (
      <Stack gap="lg">
        <Title order={1} fz="1.75rem">
          Agents
        </Title>
        <EmptyState
          icon="bolt"
          title="Les agents n'ont encore rien fait"
          description="Le premier passage a lieu à 17:00 un jour de semaine : sélection, publication, debrief."
        />
      </Stack>
    );
  }

  const successRate = kpis.attempted14d
    ? Math.round((100 * kpis.published14d) / kpis.attempted14d)
    : undefined;
  const brands = [
    ...desirability.brands.filter((b) => b.value > 0).slice(0, 12),
    ...desirability.brands.filter((b) => b.value < 0).slice(-8),
  ];
  const filteredReports = reports.filter(
    (r) => reportFilter === "all" || r.type === reportFilter,
  );
  const days = rules.publishDays.map((d) => DAYS[d]).join(", ");

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <Stack gap={2}>
          <Title order={1} fz="1.75rem">
            Agents
          </Title>
          <Text fz="sm" c="dimmed">
            Ce que les agents DealRadar ont choisi, publié, appris et réglé —
            chaque soir, sur le serveur.
          </Text>
        </Stack>
        <Group gap="xs">
          <Tooltip label={`Mises à jour par ${rules.updatedBy}`}>
            <Badge variant="light" color="gray">
              Règles v{rules.version} · {rules.updatedAt}
            </Badge>
          </Tooltip>
          <Tooltip label={`Mise à jour par ${desirability.updatedBy}`}>
            <Badge variant="light" color="gray">
              Désirabilité v{desirability.version} · {desirability.updatedAt}
            </Badge>
          </Tooltip>
        </Group>
      </Group>

      <SimpleGrid cols={{ base: 2, md: 3, lg: 5 }} spacing="md">
        <StatTile
          label="Publiés (14 j)"
          value={kpis.published14d}
          icon="check"
          hint={`sur ${kpis.attempted14d} tentatives`}
        />
        <StatTile
          label="Réussite des publications"
          value={successRate === undefined ? "" : f.percent(successRate)}
          empty={successRate === undefined}
          icon="trendingUp"
          hint="publiés / tentés (page refusée, doublon…)"
        />
        <StatTile
          label="Passés hot (100°+)"
          value={kpis.hot14d}
          icon="flame"
          hint={`sur ${kpis.measured} posts mesurés`}
        />
        <StatTile
          label="Température médiane"
          value={
            kpis.medianTemperature === undefined
              ? ""
              : `${kpis.medianTemperature}°`
          }
          empty={kpis.medianTemperature === undefined}
          icon="chart"
          hint="des posts des agents"
        />
        <StatTile
          label="Prochaine soirée"
          value={
            <Text fz="1.1rem" fw={700}>
              {nextRun(rules.publishDays)}
            </Text>
          }
          icon="clock"
          hint={`publications ${rules.windowStart}–${rules.windowEnd}`}
        />
      </SimpleGrid>

      <Tabs defaultValue={tab ?? "activite"} keepMounted={false}>
        <Tabs.List mb="lg">
          <Tabs.Tab
            value="activite"
            leftSection={<Icon name="clock" size={14} />}
          >
            Activité
          </Tabs.Tab>
          <Tabs.Tab
            value="rapports"
            leftSection={<Icon name="inbox" size={14} />}
          >
            Rapports
            <Badge size="xs" variant="light" ml={6}>
              {reports.length}
            </Badge>
          </Tabs.Tab>
          <Tabs.Tab
            value="poids"
            leftSection={<Icon name="settings" size={14} />}
          >
            Poids de sélection
          </Tabs.Tab>
          <Tabs.Tab value="lecons" leftSection={<Icon name="bolt" size={14} />}>
            Leçons
            <Badge size="xs" variant="light" ml={6}>
              {overview.lessons.length}
            </Badge>
          </Tabs.Tab>
          <Tabs.Tab
            value="reglages"
            leftSection={<Icon name="refresh" size={14} />}
          >
            Historique des réglages
          </Tabs.Tab>
        </Tabs.List>

        {/* ── Activité ── */}
        <Tabs.Panel value="activite">
          <Grid gap="lg">
            <Grid.Col span={12}>
              <TonightPlan initial={tonight} />
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Section
                title="Soirées"
                description="Le tirage du jour et ce qu'il est devenu."
              >
                <Paper p="md">
                  {overview.days.length === 0 ? (
                    <Text fz="sm" c="dimmed">
                      Aucune soirée sur les 14 derniers jours.
                    </Text>
                  ) : (
                    <Timeline
                      bulletSize={22}
                      lineWidth={2}
                      active={overview.days.length}
                    >
                      {overview.days.map((day) => (
                        <Timeline.Item
                          key={day.date}
                          bullet={
                            <Icon
                              name={day.published > 0 ? "check" : "clock"}
                              size={12}
                            />
                          }
                          title={new Date(
                            `${day.date}T12:00:00`,
                          ).toLocaleDateString("fr-FR", {
                            weekday: "long",
                            day: "numeric",
                            month: "long",
                          })}
                        >
                          <Text fz="xs" c="dimmed" mb={6}>
                            Tirage : {day.planned} publication(s)
                            {day.times.length
                              ? ` à ${day.times.join(", ")}`
                              : ""}
                          </Text>
                          <Group gap={6}>
                            {day.published ? (
                              <Badge color="teal" variant="light">
                                {day.published} publié(s)
                              </Badge>
                            ) : null}
                            {day.ignored ? (
                              <Badge color="gray" variant="light">
                                {day.ignored} ignoré(s)
                              </Badge>
                            ) : null}
                            {day.duplicates ? (
                              <Badge color="orange" variant="light">
                                {day.duplicates} doublon(s)
                              </Badge>
                            ) : null}
                            {day.failed ? (
                              <Badge color="red" variant="light">
                                {day.failed} échec(s)
                              </Badge>
                            ) : null}
                          </Group>
                        </Timeline.Item>
                      ))}
                    </Timeline>
                  )}
                </Paper>
              </Section>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Section
                title="Deals tentés"
                description="Chaque tentative de publication, la plus récente en haut, avec sa température sur Dealabs."
              >
                <Paper p={0} style={{ overflow: "hidden" }}>
                  <Table.ScrollContainer minWidth={640}>
                    <Table
                      verticalSpacing="sm"
                      horizontalSpacing="md"
                      highlightOnHover
                    >
                      <Table.Thead>
                        <Table.Tr>
                          <Table.Th>Quand</Table.Th>
                          <Table.Th>Deal</Table.Th>
                          <Table.Th>Prix</Table.Th>
                          <Table.Th>Résultat</Table.Th>
                          <Table.Th>Température</Table.Th>
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {overview.posts.map((post, i) => {
                          const result = RESULT[post.result] ?? RESULT.failed;
                          return (
                            <Table.Tr key={i}>
                              <Table.Td>
                                <Text fz="sm">{f.dayShort(post.date)}</Text>
                                <Text fz="xs" c="dimmed">
                                  {post.time}
                                </Text>
                              </Table.Td>
                              <Table.Td maw={340}>
                                {post.url ? (
                                  <Anchor
                                    href={post.url}
                                    target="_blank"
                                    rel="noreferrer"
                                    fz="sm"
                                    lineClamp={2}
                                  >
                                    {post.title}
                                  </Anchor>
                                ) : (
                                  <Text fz="sm" lineClamp={2}>
                                    {post.title}
                                  </Text>
                                )}
                                <Text fz="xs" c="dimmed" lineClamp={1}>
                                  {[
                                    post.sourceId,
                                    post.categoryId &&
                                      categoryName(post.categoryId),
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Text fz="sm" className="tnum">
                                  {post.price === undefined
                                    ? "—"
                                    : post.price === 0
                                      ? "Gratuit"
                                      : f.price(post.price)}
                                </Text>
                              </Table.Td>
                              <Table.Td>
                                <Tooltip
                                  label={post.reason ?? ""}
                                  disabled={!post.reason}
                                  multiline
                                  w={320}
                                >
                                  <Badge color={result.color} variant="light">
                                    {result.label}
                                  </Badge>
                                </Tooltip>
                              </Table.Td>
                              <Table.Td>
                                <TemperatureBadge value={post.temperature} />
                              </Table.Td>
                            </Table.Tr>
                          );
                        })}
                      </Table.Tbody>
                    </Table>
                  </Table.ScrollContainer>
                  {overview.posts.length === 0 ? (
                    <Text fz="sm" c="dimmed" ta="center" py="lg">
                      Aucune tentative sur les 14 derniers jours.
                    </Text>
                  ) : null}
                </Paper>
              </Section>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        {/* ── Rapports ── */}
        <Tabs.Panel value="rapports">
          <Grid gap="lg">
            <Grid.Col span={{ base: 12, md: 4 }}>
              <Stack gap="sm">
                <SegmentedControl
                  fullWidth
                  size="xs"
                  value={reportFilter}
                  onChange={setReportFilter}
                  data={[
                    { value: "all", label: "Tous" },
                    { value: "soiree", label: "Soirées" },
                    { value: "debrief", label: "Debriefs" },
                    { value: "sources", label: "Sources" },
                    { value: "bilan", label: "Bilans" },
                  ]}
                />
                {filteredReports.length === 0 ? (
                  <Text fz="sm" c="dimmed" ta="center" py="md">
                    Pas encore de rapport de ce type.
                  </Text>
                ) : null}
                {filteredReports.map((item) => {
                  const type = REPORT_TYPES[item.type];
                  const active = report?.id === item.id;
                  return (
                    <Paper
                      key={item.id}
                      component={Link}
                      href={`/agents?tab=rapports&report=${item.id}`}
                      p="sm"
                      withBorder
                      style={{
                        textDecoration: "none",
                        color: "inherit",
                        borderColor: active
                          ? `var(--mantine-color-${type.color}-6)`
                          : undefined,
                        borderLeftWidth: 3,
                        borderLeftColor: `var(--mantine-color-${type.color}-6)`,
                      }}
                    >
                      <Group justify="space-between" gap="xs" mb={4}>
                        <Badge color={type.color} variant="light" size="sm">
                          {type.icon} {type.label}
                        </Badge>
                        <Text fz="xs" c="dimmed">
                          {f.dayShort(item.date)}
                        </Text>
                      </Group>
                      <Text fz="sm" fw={600}>
                        {item.title}
                      </Text>
                      {item.summary ? (
                        <Text fz="xs" c="dimmed" lineClamp={3} mt={2}>
                          {item.summary}
                        </Text>
                      ) : null}
                    </Paper>
                  );
                })}
              </Stack>
            </Grid.Col>
            <Grid.Col span={{ base: 12, md: 8 }}>
              <Paper p="lg">
                {report ? (
                  <Markdown source={report.markdown} />
                ) : (
                  <EmptyState
                    icon="inbox"
                    title="Aucun rapport pour l'instant"
                    description="Les rapports apparaissent après la première soirée des agents."
                  />
                )}
              </Paper>
            </Grid.Col>
          </Grid>
        </Tabs.Panel>

        {/* ── Poids de sélection ── */}
        <Tabs.Panel value="poids">
          <Stack gap="xl">
            <Section
              title="Seuils et volume"
              description="Les règles fixes de la sélection du soir (config/publish-rules.json)."
            >
              <SimpleGrid cols={{ base: 2, md: 3, lg: 6 }} spacing="md">
                <StatTile
                  label="Score minimum"
                  value={`${rules.minScore}/100`}
                  hint="qualité du prix"
                />
                <StatTile
                  label="Chance hot minimum"
                  value={`${rules.minHotChance} %`}
                  hint="après bonus/malus"
                />
                <StatTile
                  label="Publications / jour"
                  value={`${rules.perDayMin} à ${rules.perDayMax}`}
                  hint="nombre tiré au hasard"
                />
                <StatTile
                  label="Fenêtre"
                  value={
                    <Text
                      fz="1.1rem"
                      fw={700}
                    >{`${rules.windowStart}–${rules.windowEnd}`}</Text>
                  }
                  hint={days}
                />
                <StatTile
                  label="Max par catégorie / jour"
                  value={rules.maxPerCategoryPerDay}
                  hint={
                    rules.categoryCaps
                      .map((c) => `${categoryName(c.key)} : ${c.value}`)
                      .join(" · ") || undefined
                  }
                />
                <Paper p="md" h="100%">
                  <Text fz="xs" c="dimmed" fw={500} mb={6}>
                    Sources exclues
                  </Text>
                  <Group gap={4}>
                    {rules.excludedSources.map((s) => (
                      <Badge key={s} color="red" variant="light" size="sm">
                        {s}
                      </Badge>
                    ))}
                  </Group>
                </Paper>
              </SimpleGrid>
            </Section>

            <Section
              title="Bonus et malus de sélection"
              description="Points ajoutés à la chance hot estimée d'un deal avant de la comparer au seuil. Vert = favorisé, rouge = freiné."
            >
              <Grid gap="lg">
                <Grid.Col span={{ base: 12, md: 7 }}>
                  <Paper p="md" h="100%">
                    <Text fw={600} fz="sm" mb="sm">
                      Par catégorie
                    </Text>
                    <WeightChart
                      rows={rules.categoryAdjust}
                      label={categoryName}
                      unit=" pts"
                      empty="Aucun bonus par catégorie."
                    />
                  </Paper>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 5 }}>
                  <Stack gap="lg" h="100%">
                    <Paper p="md">
                      <Text fw={600} fz="sm" mb="sm">
                        Par boutique
                      </Text>
                      <WeightChart
                        rows={rules.sourceAdjust}
                        label={(k) => f.titleize(k)}
                        unit=" pts"
                        empty="Aucun bonus par boutique."
                      />
                    </Paper>
                    {rules.locked.length ? (
                      <Paper p="md">
                        <Text fw={600} fz="sm" mb={6}>
                          🔒 Tes préférences verrouillées
                        </Text>
                        <Text fz="xs" c="dimmed" mb="xs">
                          Les agents peuvent les renforcer, jamais les
                          affaiblir.
                        </Text>
                        <Group gap={6}>
                          {rules.locked.map((l) => (
                            <Badge key={l} variant="outline" color="gray">
                              {l}
                            </Badge>
                          ))}
                        </Group>
                      </Paper>
                    ) : null}
                  </Stack>
                </Grid.Col>
              </Grid>
            </Section>

            <Section
              title="Désirabilité"
              description="Ce que la communauté Dealabs veut vraiment : un bonus ou malus par marque et par type de produit, mesuré sur les votes réels et ajusté chaque soir par le debrief (+0,5 ≈ 1,6 fois plus de chances de passer hot)."
            >
              <Grid gap="lg">
                <Grid.Col span={{ base: 12, md: 7 }}>
                  <Paper p="md" h="100%">
                    <Group justify="space-between" mb="sm">
                      <Text fw={600} fz="sm">
                        Marques (les plus et les moins aimées)
                      </Text>
                      <Text fz="xs" c="dimmed">
                        {desirability.knownBrands} marques connues
                      </Text>
                    </Group>
                    <WeightChart
                      rows={brands}
                      label={(k) => k}
                      unit=""
                      empty="Aucun poids de marque."
                    />
                  </Paper>
                </Grid.Col>
                <Grid.Col span={{ base: 12, md: 5 }}>
                  <Stack gap="lg">
                    <Paper p="md">
                      <Group gap="sm" wrap="nowrap">
                        <ThemeIcon
                          color={
                            desirability.noBrandPenalty < 0 ? "red" : "gray"
                          }
                          variant="light"
                          size="lg"
                        >
                          <Icon name="alert" size={18} />
                        </ThemeIcon>
                        <div>
                          <Text fw={600} fz="sm">
                            Marque inconnue :{" "}
                            {desirability.noBrandPenalty > 0 ? "+" : ""}
                            {desirability.noBrandPenalty}
                          </Text>
                          <Text fz="xs" c="dimmed">
                            Appliqué aux produits tech, maison, bricolage… sans
                            marque reconnue.
                          </Text>
                        </div>
                      </Group>
                    </Paper>
                    <Paper p="md">
                      <Text fw={600} fz="sm" mb="sm">
                        Types de produit
                      </Text>
                      <WeightChart
                        rows={desirability.keywords}
                        label={(k) => f.titleize(k)}
                        unit=""
                        empty="Aucun poids de type."
                      />
                    </Paper>
                  </Stack>
                </Grid.Col>
              </Grid>
            </Section>

            <Section
              title="Collecte"
              description="Combien de pages produit sont lues par passage, quelles pages en plus, et à quelle fréquence tourne chaque source (ajusté chaque jour par l'agent Sources)."
            >
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
                {(["amazon", "cdiscount"] as const).map((name) => {
                  const shop = collection[name];
                  const [min, max] = shop.bounds;
                  return (
                    <Paper key={name} p="md">
                      <Group justify="space-between" mb={6}>
                        <Text fw={600}>{f.titleize(name)}</Text>
                        <Text fz="sm" className="tnum">
                          {shop.limit} pages / passage
                        </Text>
                      </Group>
                      <Progress
                        value={
                          max > min
                            ? ((shop.limit - min) / (max - min)) * 100
                            : 0
                        }
                        color="blue"
                        size="sm"
                        mb={4}
                      />
                      <Group justify="space-between" mb="sm">
                        <Text fz="xs" c="dimmed">
                          {min}
                        </Text>
                        <Text fz="xs" c="dimmed">
                          {max}
                        </Text>
                      </Group>
                      <Group gap={6}>
                        {shop.pages.map((page) => (
                          <Badge
                            key={page.key}
                            color={page.enabled ? "teal" : "gray"}
                            variant={page.enabled ? "light" : "outline"}
                          >
                            {page.enabled ? "✓" : "○"} {page.key}
                          </Badge>
                        ))}
                      </Group>
                    </Paper>
                  );
                })}
              </SimpleGrid>
              <Paper p="md" mt="lg">
                <Group justify="space-between" mb="sm">
                  <Text fw={600}>Sources et fréquence</Text>
                  <Text fz="xs" c="dimmed">
                    🔒 = gardée par Adam, jamais coupée
                  </Text>
                </Group>
                <Group gap={6}>
                  {collection.sources.map((source) => (
                    <Badge
                      key={source.id}
                      color={
                        !source.enabled
                          ? "gray"
                          : source.everyHours > 1
                            ? "blue"
                            : "teal"
                      }
                      variant={source.enabled ? "light" : "outline"}
                    >
                      {source.locked ? "🔒 " : ""}
                      {source.id} ·{" "}
                      {!source.enabled
                        ? "coupée"
                        : source.everyHours > 1
                          ? `toutes les ${source.everyHours} h`
                          : "chaque heure"}
                    </Badge>
                  ))}
                </Group>
              </Paper>
            </Section>
          </Stack>
        </Tabs.Panel>

        {/* ── Leçons ── */}
        <Tabs.Panel value="lecons">
          <Section
            title="Leçons apprises"
            description="Règles tirées des températures et des commentaires réels, écrites par le debrief du soir et appliquées par la sélection."
          >
            {overview.lessons.length === 0 ? (
              <EmptyState
                icon="bolt"
                title="Pas encore de leçon"
                description="Le debrief en écrit dès que plusieurs posts vont dans le même sens."
              />
            ) : (
              <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
                {overview.lessons.map((lesson, i) => (
                  <Paper key={i} p="md" withBorder>
                    <Group gap="sm" align="flex-start" wrap="nowrap">
                      <ThemeIcon
                        variant="light"
                        color="pink"
                        radius="xl"
                        size="md"
                      >
                        <Text fz="xs" fw={700}>
                          {i + 1}
                        </Text>
                      </ThemeIcon>
                      <Stack gap={6} style={{ minWidth: 0 }}>
                        <Text fw={600} fz="sm">
                          {lesson.rule}
                        </Text>
                        <Text fz="xs" c="dimmed">
                          {lesson.proof}
                        </Text>
                        {lesson.addedAt ? (
                          <Text fz="xs" c="dimmed">
                            Ajoutée le {f.date(lesson.addedAt)}
                          </Text>
                        ) : null}
                      </Stack>
                    </Group>
                  </Paper>
                ))}
              </SimpleGrid>
            )}
          </Section>
        </Tabs.Panel>

        {/* ── Historique des réglages ── */}
        <Tabs.Panel value="reglages">
          <Section
            title="Historique des réglages"
            description="Chaque changement de règle, de poids ou de collecte, avec ses chiffres."
          >
            <Paper p="lg">
              <Timeline bulletSize={20} lineWidth={2}>
                {overview.changelog.map((entry, i) => (
                  <Timeline.Item
                    key={i}
                    bullet={<Icon name="refresh" size={11} />}
                    title={
                      <Group gap="xs">
                        <Text fw={600} fz="sm">
                          {entry.title}
                        </Text>
                        <Badge
                          size="xs"
                          variant="light"
                          color={
                            entry.source.startsWith("Règles")
                              ? "violet"
                              : entry.source === "Sources"
                                ? "yellow"
                                : "teal"
                          }
                        >
                          {entry.source}
                        </Badge>
                      </Group>
                    }
                  >
                    <Stack mt="xs">
                      <Markdown source={entry.body} />
                    </Stack>
                  </Timeline.Item>
                ))}
              </Timeline>
            </Paper>
          </Section>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
};

export default AgentsPage;
