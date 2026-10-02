import { LineChart } from "@mantine/charts";
import {
  ActionIcon,
  Alert,
  Anchor,
  Badge,
  Box,
  Button,
  Card,
  Divider,
  Grid,
  Group,
  Paper,
  Select,
  Stack,
  Table,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Link, useRouter } from "alepha/react/router";
import { type FC, useEffect, useMemo, useState } from "react";

import type { DealsController } from "../../api/controllers/DealsController.ts";
import type { DraftsController } from "../../api/controllers/DraftsController.ts";
import DealImage from "../components/deals/DealImage.tsx";
import * as f from "../components/ui/format.ts";
import Icon from "../components/ui/Icon.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import type {
  Deal,
  DealClassification,
  Draft,
  IdealoHistoryPoint,
  PricePoint,
  PriceStats,
  RefItem,
} from "../types.ts";

export interface DealDetailPageProps {
  deal: Deal;
  history: PricePoint[];
  stats: PriceStats;
  draft: Draft | null;
  merchants: RefItem[];
  categories: RefItem[];
}

/**
 * Labels/tones for {@link PriceStats.classification} — the single mapping
 * every badge and the assessment alert draw from, so the wording and the
 * colour can never drift apart from each other or from the numeric score.
 */
const CLASSIFICATION: Record<
  DealClassification,
  { label: string; tone: "good" | "neutral" | "warn" }
> = {
  excellent: { label: "Excellente affaire", tone: "good" },
  good: { label: "Bonne affaire", tone: "good" },
  average: { label: "Prix normal", tone: "neutral" },
  overpriced: { label: "Au-dessus du marché", tone: "warn" },
  unknown: { label: "Pas assez de données", tone: "neutral" },
};

/**
 * Turns the price statistics into a sentence.
 *
 * The chart below shows *what* happened; this says *whether it is a good
 * time to buy*, which is the only question the user actually has. Every
 * branch is derived from observed data — when there is not enough history we
 * say that, rather than reaching for a reassuring phrase.
 *
 * When an external market reference price is available (Idealo's lowest
 * listed price across merchants), the comparison is made against that
 * instead of our own history — a thin history of one product can't always
 * tell a real deal from a product that simply never moves, while Idealo
 * reflects the wider market.
 */
const verdict = (
  stats: PriceStats,
  currency: string,
): { tone: "good" | "neutral" | "warn"; text: string } => {
  const tone = CLASSIFICATION[stats.classification].tone;

  if (stats.referencePrice !== null && stats.referencePrice > 0) {
    const marketDiffPercentage = Math.round(
      ((stats.currentPrice - stats.referencePrice) / stats.referencePrice) *
        100,
    );
    const referencePriceLabel = f.price(stats.referencePrice, currency);

    if (marketDiffPercentage <= 0) {
      return {
        tone,
        text: `Prix inférieur de ${Math.abs(marketDiffPercentage)} % au meilleur prix du marché relevé sur Idealo (${referencePriceLabel}).`,
      };
    }
    return {
      tone,
      text: `Prix supérieur de ${marketDiffPercentage} % au meilleur prix du marché relevé sur Idealo (${referencePriceLabel}) : ${marketDiffPercentage <= 3 ? "c'est à peu près le prix normal actuellement." : "ce n'est pas un bon plan pour l'instant."}`,
    };
  }

  if (stats.historyPoints < 2) {
    return {
      tone,
      text: "Pas encore assez de relevés pour situer ce prix : l'historique commence à la première collecte de cette offre.",
    };
  }
  if (stats.isNewHistoricalMin) {
    return {
      tone,
      text: `C'est le prix le plus bas observé depuis le début du suivi (${stats.historyPoints} relevés).`,
    };
  }
  if (stats.vsAveragePercentage !== null && stats.vsAveragePercentage <= -5) {
    return {
      tone,
      text: `Prix actuel inférieur de ${Math.abs(Math.round(stats.vsAveragePercentage))} % à la moyenne observée (${f.price(stats.avgPrice, currency)}).`,
    };
  }
  if (stats.vsAveragePercentage !== null && stats.vsAveragePercentage >= 5) {
    return {
      tone,
      text: `Prix actuel supérieur de ${Math.round(stats.vsAveragePercentage)} % à la moyenne observée (${f.price(stats.avgPrice, currency)}). Le minimum relevé est de ${f.price(stats.minPrice, currency)}.`,
    };
  }
  return {
    tone,
    text: `Prix proche de la moyenne observée (${f.price(stats.avgPrice, currency)}), minimum relevé à ${f.price(stats.minPrice, currency)}.`,
  };
};

const DealDetailPage: FC<DealDetailPageProps> = ({
  deal,
  history,
  stats,
  draft,
  merchants,
  categories,
}) => {
  const drafts = useClient<DraftsController>();
  const deals = useClient<DealsController>();
  const router = useRouter();
  const [current, setCurrent] = useState(draft);
  const [saving, setSaving] = useState(false);
  const [dealabsUrlInput, setDealabsUrlInput] = useState(
    draft?.dealabsUrl ?? "",
  );
  const [verifying, setVerifying] = useState(false);
  const [autoPublishing, setAutoPublishing] = useState(false);

  /**
   * Idealo's own price-history chart, fetched live the moment this page
   * opens (not pre-loaded server-side: it can take several seconds and
   * sometimes just fails against Idealo's bot protection, which shouldn't
   * block rendering everything else). `undefined` while loading, `null`
   * once the fetch settles with nothing usable.
   */
  const [idealoHistory, setIdealoHistory] = useState<
    IdealoHistoryPoint[] | null | undefined
  >(deal.idealoUrl ? undefined : null);

  useEffect(() => {
    if (!deal.idealoUrl) {
      return;
    }
    let cancelled = false;
    deals
      .idealoHistory({ params: { id: deal.id } })
      .then((result) => {
        if (!cancelled) {
          setIdealoHistory(result.available ? result.points : null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIdealoHistory(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [deal.id, deal.idealoUrl, deals]);

  const savingAmount = f.savings(deal.currentPrice, deal.listPrice);
  const merchant =
    merchants.find((row) => row.id === deal.merchantId)?.name ??
    f.titleize(deal.merchantId ?? deal.sourceId);
  const category = categories.find((row) => row.id === deal.categoryId)?.name;
  const assessment = verdict(stats, deal.currency);

  /**
   * "Temps disponible" field for Dealabs: in-stock/out-of-stock status plus
   * the validity window, when the merchant/source gave us one. Dealabs
   * itself doesn't expose start/end dates on deals, so this is informative
   * text for the post body, not a structured field.
   */
  const availabilityLabel = (() => {
    const stockLabel =
      deal.availability === "in_stock"
        ? "En stock"
        : deal.availability === "out_of_stock"
          ? "Rupture de stock"
          : "Disponibilité inconnue";
    const window =
      deal.startDate && deal.endDate
        ? `valable du ${f.date(deal.startDate)} au ${f.date(deal.endDate)}`
        : deal.endDate
          ? `valable jusqu'au ${f.date(deal.endDate)}`
          : undefined;
    return window ? `${stockLabel}, ${window}` : stockLabel;
  })();

  const series = useMemo(
    () =>
      history.map((point) => ({
        date: f.dayShort(point.observedAt),
        Prix: point.price,
      })),
    [history],
  );

  /**
   * Explicit domain rather than recharts' "dataMin/dataMax" keywords: those
   * only ever look at `series` itself, so the Idealo reference line (often
   * above everything our own history ever recorded) would silently render
   * outside the visible chart area without this.
   */
  const yAxisDomain = useMemo((): [number, number] => {
    const values = [
      ...history.map((point) => point.price),
      ...(stats.referencePrice !== null ? [stats.referencePrice] : []),
    ];
    if (values.length === 0) {
      return [0, 1];
    }
    const min = Math.min(...values);
    const max = Math.max(...values);
    const padding = Math.max((max - min) * 0.1, 1);
    return [Math.max(0, min - padding), max + padding];
  }, [history, stats.referencePrice]);

  const idealoSeries = useMemo(
    () =>
      (idealoHistory ?? []).map((point) => ({
        date: f.dayShort(point.date),
        Prix: point.price,
      })),
    [idealoHistory],
  );

  const save = async (patch: Partial<Draft>) => {
    if (!current) return;
    setSaving(true);
    try {
      const updated = await drafts.update({
        params: { id: deal.id },
        body: patch,
      });
      setCurrent(updated as Draft);
      notifications.show({
        message: "Brouillon enregistré",
        color: "signal",
        icon: <Icon name="check" size={16} />,
      });
    } catch {
      notifications.show({
        title: "Échec de l'enregistrement",
        message: "Le brouillon n'a pas pu être sauvegardé.",
        color: "red",
        icon: <Icon name="alert" size={16} />,
      });
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    if (!current) return;
    await navigator.clipboard.writeText(`${current.title}\n\n${current.body}`);
    notifications.show({ message: "Copié dans le presse-papiers" });
  };

  /** Copies one quick-fill field value and confirms with a toast. */
  const copyField = async (label: string, value: string) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    notifications.show({ message: `${label} copié`, autoClose: 2000 });
  };

  /**
   * Starts the publish flow: opens Dealabs (real, working URL — their
   * submission form lives behind a "Poster un bon plan" button client-side,
   * not at a stable deep link) and copies the ready-to-paste draft. Nothing
   * is submitted for you — Dealabs doesn't support prefilling its form via
   * URL, so you paste the title/body yourself and click Dealabs' own
   * submit button.
   *
   * `window.open` must run before the `await`: browsers drop "user
   * activation" across an async gap, so calling it after the clipboard
   * write gets it silently blocked as a popup.
   */
  const publish = async () => {
    if (!current) return;
    window.open("https://www.dealabs.com/bons-plans", "_blank", "noopener");
    await navigator.clipboard.writeText(`${current.title}\n\n${current.body}`);
    notifications.show({
      title: "Brouillon copié",
      message:
        "Sur Dealabs, cliquez sur « Poster un bon plan », puis collez le titre et le texte copiés. Revenez ensuite coller le lien ci-dessous pour vérifier.",
      autoClose: 8000,
    });
  };

  const verify = async () => {
    if (!current || !dealabsUrlInput.trim()) return;
    setVerifying(true);
    try {
      const { matched, draft: updated } = await drafts.verify({
        params: { id: deal.id },
        body: { dealabsUrl: dealabsUrlInput.trim() },
      });
      setCurrent(updated as Draft);
      notifications.show({
        message: matched
          ? "Publication confirmée et enregistrée comme publiée."
          : "Le lien ne correspond pas (encore) à ce brouillon : non marqué comme publié.",
        color: matched ? "signal" : "orange",
        icon: <Icon name={matched ? "check" : "alert"} size={16} />,
      });
    } catch {
      notifications.show({
        title: "Échec de la vérification",
        message: "Impossible de vérifier ce lien pour le moment.",
        color: "red",
        icon: <Icon name="alert" size={16} />,
      });
    } finally {
      setVerifying(false);
    }
  };

  /**
   * Full auto-publish: the backend logs into Dealabs with your saved
   * session (`npm run dealabs:login`), fills the form, and submits it.
   * Only available against the local dev server / bare Node deploy — the
   * serverless deployment rejects it with a clear error, since there's no
   * real browser session to reuse there.
   */
  const autoPublish = async () => {
    if (!current) return;
    setAutoPublishing(true);
    try {
      const updated = await drafts.autoPublish({ params: { id: deal.id } });
      setCurrent(updated as Draft);
      setDealabsUrlInput(updated.dealabsUrl ?? "");
      notifications.show({
        message: "Publié automatiquement sur Dealabs.",
        color: "signal",
        icon: <Icon name="check" size={16} />,
      });
    } catch (error) {
      notifications.show({
        title: "Échec de la publication automatique",
        message:
          error instanceof Error
            ? error.message
            : "La publication automatique a échoué.",
        color: "red",
        icon: <Icon name="alert" size={16} />,
        autoClose: 10000,
      });
    } finally {
      setAutoPublishing(false);
    }
  };

  /**
   * Plain `href="/deals"` always landed back on page 1 with every filter
   * cleared — the URL it points to has no memory of where the user was.
   * Going back through browser history instead returns to the exact
   * listing URL (filters, sort, page) the user left, with scroll position
   * restored by the browser for free. Falls back to a normal navigation
   * when there is nothing to go back to in-app (deep link, shared URL,
   * new tab) rather than leaving the click inert.
   */
  const handleBackClick = (event: { preventDefault: () => void }) => {
    if (router.canGoBack) {
      event.preventDefault();
      void router.back();
    }
  };

  return (
    <Stack gap="lg">
      <Anchor
        component={Link}
        href="/deals"
        fz="sm"
        c="dimmed"
        onClick={handleBackClick}
      >
        <Group gap={4} wrap="nowrap">
          <Icon name="chevronLeft" size={14} />
          Retour aux bons plans
        </Group>
      </Anchor>

      <Grid gap="xl">
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Paper p="md" pos={{ md: "sticky" }} top={72}>
            <DealImage
              src={deal.imageUrl}
              alt={deal.title}
              ratio={1}
              loading="eager"
              fallbackLabel={merchant}
            />
          </Paper>
        </Grid.Col>

        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack gap="md">
            <Group gap={6}>
              <Badge
                variant="light"
                color="gray"
                leftSection={<Icon name="store" size={11} />}
              >
                {merchant}
              </Badge>
              {category ? (
                <Badge
                  variant="light"
                  color="gray"
                  component={Link}
                  href={`/deals?categoryId=${deal.categoryId}`}
                  style={{ cursor: "pointer" }}
                >
                  {category}
                </Badge>
              ) : null}
              <Badge
                variant="light"
                color={deal.status === "active" ? "signal" : "gray"}
              >
                {deal.status === "active" ? "Offre active" : "Offre expirée"}
              </Badge>
            </Group>

            <Title order={1} fz={{ base: "1.4rem", sm: "1.75rem" }} lh={1.2}>
              {deal.title}
            </Title>

            <Paper p="md" bg="var(--app-surface-muted)">
              <Group gap="md" align="baseline" wrap="wrap">
                <Text fz="2.25rem" fw={700} lh={1} className="tnum">
                  {f.price(deal.currentPrice, deal.currency)}
                </Text>
                {deal.listPrice && deal.listPrice > deal.currentPrice ? (
                  <Text fz="lg" c="dimmed" td="line-through" className="tnum">
                    {f.price(deal.listPrice, deal.currency)}
                  </Text>
                ) : null}
                {(deal.discountPercentage ?? 0) >= 1 ? (
                  <Badge
                    size="lg"
                    color="signal"
                    variant="filled"
                    className="tnum"
                  >
                    {f.discount(deal.discountPercentage as number)}
                  </Badge>
                ) : null}
                <Badge
                  size="lg"
                  variant="light"
                  color={
                    CLASSIFICATION[stats.classification].tone === "good"
                      ? "signal"
                      : CLASSIFICATION[stats.classification].tone === "warn"
                        ? "orange"
                        : "gray"
                  }
                >
                  {CLASSIFICATION[stats.classification].label}
                </Badge>
              </Group>
              {savingAmount !== null ? (
                <Text fz="md" fw={600} c="signal.6" mt={6} className="tnum">
                  Économisez {f.price(savingAmount, deal.currency)}
                </Text>
              ) : (
                <Text fz="sm" c="dimmed" mt={6}>
                  Aucun prix de référence relevé chez ce marchand : la réduction
                  ne peut pas être calculée.
                </Text>
              )}
            </Paper>

            {deal.description ? (
              <Paper p="md" withBorder>
                <Text fz="xs" fw={700} c="dimmed" tt="uppercase" mb={4}>
                  Description du produit
                </Text>
                <Text fz="sm" style={{ whiteSpace: "pre-line" }}>
                  {deal.description}
                </Text>
              </Paper>
            ) : null}

            <Alert
              variant="light"
              color={
                assessment.tone === "good"
                  ? "signal"
                  : assessment.tone === "warn"
                    ? "orange"
                    : "gray"
              }
              icon={
                <Icon
                  name={
                    assessment.tone === "good"
                      ? "trendingDown"
                      : assessment.tone === "warn"
                        ? "trendingUp"
                        : "clock"
                  }
                  size={18}
                />
              }
              title="Ce prix est-il intéressant ?"
            >
              {assessment.text}
            </Alert>

            <Group gap="sm">
              <Button
                component="a"
                href={deal.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                size="md"
                rightSection={<Icon name="external" size={16} />}
              >
                Voir l'offre chez {merchant}
              </Button>
            </Group>

            <Table variant="vertical" withTableBorder={false} fz="sm">
              <Table.Tbody>
                <Table.Tr>
                  <Table.Th w={180}>Score</Table.Th>
                  <Table.Td className="tnum">{deal.score} / 100</Table.Td>
                </Table.Tr>
                {stats.referencePrice !== null ? (
                  <Table.Tr>
                    <Table.Th>Prix de référence marché</Table.Th>
                    <Table.Td className="tnum">
                      {f.price(stats.referencePrice, deal.currency)}
                      <Text component="span" c="dimmed" fz="xs">
                        {" "}
                        (Idealo, tous marchands)
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                ) : null}
                <Table.Tr>
                  <Table.Th>Disponibilité</Table.Th>
                  <Table.Td>{f.titleize(deal.availability)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Première détection</Table.Th>
                  <Table.Td>{f.dateTime(deal.firstSeenAt)}</Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Dernière observation</Table.Th>
                  <Table.Td>
                    {f.dateTime(deal.lastSeenAt)}
                    <Text component="span" c="dimmed">
                      {" "}
                      ({f.relativeTime(deal.lastSeenAt)})
                    </Text>
                  </Table.Td>
                </Table.Tr>
                <Table.Tr>
                  <Table.Th>Source</Table.Th>
                  <Table.Td>{f.titleize(deal.sourceId)}</Table.Td>
                </Table.Tr>
              </Table.Tbody>
            </Table>
          </Stack>
        </Grid.Col>
      </Grid>

      <Divider />

      <Stack gap="sm">
        <Group justify="space-between" align="flex-end" wrap="wrap">
          <Stack gap={2}>
            <Title order={2} fz="lg">
              Historique de prix
            </Title>
            <Text fz="sm" c="dimmed">
              Chaque point correspond à un relevé effectué par les collecteurs.
            </Text>
          </Stack>
          {stats.historyPoints > 1 ? (
            <Group gap="lg">
              <Box>
                <Text fz="xs" c="dimmed">
                  Minimum
                </Text>
                <Text fw={600} className="tnum">
                  {f.price(stats.minPrice, deal.currency)}
                </Text>
              </Box>
              <Box>
                <Text fz="xs" c="dimmed">
                  Moyenne
                </Text>
                <Text fw={600} className="tnum">
                  {f.price(stats.avgPrice, deal.currency)}
                </Text>
              </Box>
              <Box>
                <Text fz="xs" c="dimmed">
                  Maximum
                </Text>
                <Text fw={600} className="tnum">
                  {f.price(stats.maxPrice, deal.currency)}
                </Text>
              </Box>
              {stats.referencePrice !== null ? (
                <Box>
                  <Text fz="xs" c="dimmed">
                    Marché (Idealo)
                  </Text>
                  <Text fw={600} className="tnum">
                    {f.price(stats.referencePrice, deal.currency)}
                  </Text>
                </Box>
              ) : null}
            </Group>
          ) : null}
        </Group>

        <Paper p="md">
          {series.length > 1 ? (
            <LineChart
              h={260}
              data={series}
              dataKey="date"
              series={[{ name: "Prix", color: "signal.5" }]}
              curveType="stepAfter"
              connectNulls
              gridAxis="y"
              tickLine="none"
              withDots={series.length < 30}
              yAxisProps={{ domain: yAxisDomain }}
              valueFormatter={(value) => f.price(value, deal.currency)}
              referenceLines={[
                {
                  y: stats.avgPrice,
                  label: "Moyenne",
                  color: "var(--mantine-color-dimmed)",
                },
                ...(stats.referencePrice !== null
                  ? [
                      {
                        y: stats.referencePrice,
                        label: "Marché (Idealo)",
                        color: "var(--mantine-color-orange-6)",
                      },
                    ]
                  : []),
              ]}
            />
          ) : (
            <EmptyState
              icon="chart"
              title="Historique en cours de constitution"
              description="Un seul relevé pour l'instant. Le graphique apparaîtra dès que l'offre aura été observée plusieurs fois."
            />
          )}
        </Paper>

        {deal.idealoUrl ? (
          <Paper p="md">
            <Group justify="space-between" mb="sm">
              <Stack gap={2}>
                <Title order={5}>Historique de prix Idealo (marché)</Title>
                <Text fz="sm" c="dimmed">
                  Relevé en direct sur la fiche Idealo du produit.
                </Text>
              </Stack>
              <Anchor
                href={deal.idealoUrl}
                target="_blank"
                rel="noreferrer"
                fz="sm"
              >
                Voir sur Idealo
                <Icon name="external" size={14} />
              </Anchor>
            </Group>
            {idealoHistory === undefined ? (
              <EmptyState
                icon="chart"
                title="Chargement du graphique Idealo…"
                description="Récupération de l'historique directement depuis Idealo."
              />
            ) : idealoSeries.length > 1 ? (
              <LineChart
                h={220}
                data={idealoSeries}
                dataKey="date"
                series={[{ name: "Prix", color: "orange.6" }]}
                curveType="stepAfter"
                connectNulls
                gridAxis="y"
                tickLine="none"
                withDots={idealoSeries.length < 30}
                valueFormatter={(value) => f.price(value, deal.currency)}
              />
            ) : (
              <EmptyState
                icon="chart"
                title="Historique Idealo indisponible"
                description="Idealo bloque la récupération automatique pour le moment (protection anti-robot) ou ne publie pas d'historique pour ce produit."
              />
            )}
          </Paper>
        ) : null}
      </Stack>

      {current ? (
        <>
          <Divider />
          <Stack gap="sm">
            <Group justify="space-between" align="flex-end" wrap="wrap">
              <Stack gap={2}>
                <Title order={2} fz="lg">
                  Brouillon Dealabs
                </Title>
                <Text fz="sm" c="dimmed">
                  Généré automatiquement. Rien n'est publié : la publication
                  reste entièrement manuelle.
                </Text>
              </Stack>
              <Select
                w={170}
                value={current.status}
                data={[
                  { value: "draft", label: "À relire" },
                  { value: "posted", label: "Publié" },
                  { value: "discarded", label: "Écarté" },
                ]}
                onChange={(value) =>
                  value && void save({ status: value as Draft["status"] })
                }
                allowDeselect={false}
                aria-label="Statut du brouillon"
              />
            </Group>

            <Card p="md">
              <Stack gap="sm">
                <Stack gap={2}>
                  <Title order={3} fz="sm" fw={600}>
                    Remplir le formulaire Dealabs
                  </Title>
                  <Text fz="xs" c="dimmed">
                    Dans l'ordre où Dealabs les demande : lien, titre, prix
                    actuel, prix habituel, description, disponibilité. Copiez
                    chaque champ et collez-le au bon endroit sur Dealabs.
                  </Text>
                </Stack>
                {(
                  [
                    { label: "Lien", value: deal.url },
                    { label: "Titre", value: current.title },
                    {
                      label: "Prix actuel",
                      value: f.price(deal.currentPrice, deal.currency),
                    },
                    {
                      label: "Prix habituel",
                      value: deal.listPrice
                        ? f.price(deal.listPrice, deal.currency)
                        : "",
                    },
                    {
                      label: "Description",
                      value: current.description ?? "",
                    },
                    { label: "Disponibilité", value: availabilityLabel },
                  ] as const
                ).map((field) =>
                  field.value ? (
                    <Group
                      key={field.label}
                      gap="xs"
                      align="flex-end"
                      wrap="nowrap"
                    >
                      {field.label === "Description" ? (
                        <Textarea
                          flex={1}
                          label={field.label}
                          value={field.value}
                          readOnly
                          autosize
                          minRows={2}
                          maxRows={6}
                        />
                      ) : (
                        <TextInput
                          flex={1}
                          label={field.label}
                          value={field.value}
                          readOnly
                        />
                      )}
                      <Tooltip label={`Copier « ${field.label} »`}>
                        <ActionIcon
                          variant="default"
                          size="lg"
                          aria-label={`Copier ${field.label}`}
                          onClick={() =>
                            void copyField(field.label, field.value)
                          }
                        >
                          <Icon name="copy" size={16} />
                        </ActionIcon>
                      </Tooltip>
                    </Group>
                  ) : null,
                )}

                <Divider />

                <TextInput
                  label="Titre"
                  value={current.title}
                  onChange={(event) =>
                    setCurrent({ ...current, title: event.currentTarget.value })
                  }
                />
                <Textarea
                  label="Corps du message"
                  autosize
                  minRows={6}
                  maxRows={18}
                  value={current.body}
                  onChange={(event) =>
                    setCurrent({ ...current, body: event.currentTarget.value })
                  }
                />
                <Group gap="sm">
                  <Button
                    loading={saving}
                    onClick={() =>
                      void save({ title: current.title, body: current.body })
                    }
                  >
                    Enregistrer
                  </Button>
                  <Button variant="default" onClick={() => void copy()}>
                    Copier
                  </Button>
                  <Button
                    variant="light"
                    color="signal"
                    rightSection={<Icon name="external" size={16} />}
                    onClick={() => void publish()}
                  >
                    Publier sur Dealabs
                  </Button>
                  <Tooltip
                    label="Se connecte avec la session Dealabs enregistrée (npm run dealabs:login), ouvre une fenêtre de navigateur visible (résolvez le Cloudflare si besoin), remplit le formulaire et clique sur publier à votre place."
                    multiline
                    w={280}
                  >
                    <Button
                      variant="filled"
                      color="signal"
                      loading={autoPublishing}
                      disabled={current.status === "posted"}
                      rightSection={<Icon name="bolt" size={16} />}
                      onClick={() => void autoPublish()}
                    >
                      Publication automatique
                    </Button>
                  </Tooltip>
                </Group>

                {autoPublishing && (
                  <Text size="xs" c="dimmed">
                    Une fenêtre de navigateur va s'ouvrir sur cette machine — si
                    Dealabs affiche une vérification "je ne suis pas un robot",
                    cochez-la vous-même, le reste continue tout seul.
                  </Text>
                )}

                <Divider
                  label="Confirmer la publication"
                  labelPosition="left"
                />
                <Group gap="sm" align="flex-end" wrap="wrap">
                  <TextInput
                    flex={1}
                    miw={240}
                    label="Lien Dealabs du deal publié"
                    placeholder="https://www.dealabs.com/bons-plans/..."
                    value={dealabsUrlInput}
                    onChange={(event) =>
                      setDealabsUrlInput(event.currentTarget.value)
                    }
                  />
                  <Button
                    variant="default"
                    loading={verifying}
                    disabled={!dealabsUrlInput.trim()}
                    onClick={() => void verify()}
                  >
                    Vérifier
                  </Button>
                </Group>
                {current.dealabsUrl && current.status === "posted" ? (
                  <Text fz="sm" c="signal.6">
                    Publié et vérifié
                    {current.verifiedAt
                      ? ` le ${f.dateTime(current.verifiedAt)}`
                      : ""}{" "}
                    —{" "}
                    <Anchor
                      href={current.dealabsUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      voir sur Dealabs
                    </Anchor>
                  </Text>
                ) : null}
              </Stack>
            </Card>
          </Stack>
        </>
      ) : null}
    </Stack>
  );
};

export default DealDetailPage;
