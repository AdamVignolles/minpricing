import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Grid,
  Group,
  NumberInput,
  Paper,
  SimpleGrid,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Fragment, type FC, type FormEvent, useState } from "react";

import type { AdminController } from "../../api/controllers/AdminController.ts";
import type { ProductsController } from "../../api/controllers/ProductsController.ts";
import * as f from "../components/ui/format.ts";
import Icon from "../components/ui/Icon.tsx";
import Section from "../components/ui/Section.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import StatTile from "../components/ui/StatTile.tsx";
import type { CollectionRun, RefItem, TrackedProduct } from "../types.ts";

interface AdminStats {
  activeDeals: number;
  expiredDeals: number;
  draftsPending: number;
  trackedProducts: number;
  priceObservations: number;
  sources: Array<{
    id: string;
    name: string;
    enabled: boolean;
    lastRunAt?: string;
    lastSuccessAt?: string;
    lastErrorAt?: string;
    lastError?: string;
  }>;
}

export interface AdminPageProps {
  stats: AdminStats;
  products: TrackedProduct[];
  runs: CollectionRun[];
  sources: RefItem[];
}

/**
 * Source health, as a single word.
 *
 * Derived rather than stored: a source whose last error is more recent than
 * its last success is failing *right now*, regardless of how many times it
 * succeeded before.
 */
const sourceHealth = (source: AdminStats["sources"][number]) => {
  if (!source.enabled) return { label: "Désactivée", color: "gray" };
  if (!source.lastRunAt) return { label: "Jamais exécutée", color: "gray" };
  const failing =
    source.lastErrorAt &&
    (!source.lastSuccessAt ||
      new Date(source.lastErrorAt) > new Date(source.lastSuccessAt));
  return failing
    ? { label: "En erreur", color: "red" }
    : { label: "Opérationnelle", color: "signal" };
};

const RUN_STATUS: Record<string, { label: string; color: string }> = {
  completed: { label: "Succès", color: "signal" },
  success: { label: "Succès", color: "signal" },
  failed: { label: "Échec", color: "red" },
  running: { label: "En cours", color: "blue" },
  pending: { label: "En attente", color: "gray" },
};

const LOG_LEVEL: Record<string, { label: string; color: string }> = {
  ERROR: { label: "Erreur", color: "red" },
  WARN: { label: "Avertissement", color: "yellow" },
  INFO: { label: "Info", color: "blue" },
  DEBUG: { label: "Debug", color: "gray" },
  TRACE: { label: "Trace", color: "gray" },
};

/**
 * Per-source collection results (`{ sourceId, collected, created, updated,
 * error }`, see `CollectionSummary`) rendered as a short readable phrase
 * instead of raw JSON — that was the actual complaint: the admin UI only
 * ever showed a JSON dump of the collect response.
 */
const describeLogData = (data: unknown): string | null => {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.sourceId !== "string") return null;
  const parts: string[] = [];
  if (typeof d.collected === "number") parts.push(`${d.collected} collecté(s)`);
  if (typeof d.created === "number") parts.push(`${d.created} créé(s)`);
  if (typeof d.updated === "number") parts.push(`${d.updated} mis à jour`);
  return parts.length > 0 ? parts.join(" · ") : null;
};

const AdminPage: FC<AdminPageProps> = ({
  stats: initialStats,
  products: initialProducts,
  runs: initialRuns,
  sources,
}) => {
  const admin = useClient<AdminController>();
  const productsClient = useClient<ProductsController>();

  const [stats, setStats] = useState(initialStats);
  const [products, setProducts] = useState(initialProducts);
  const [runs, setRuns] = useState(initialRuns);
  const [running, setRunning] = useState(false);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [form, setForm] = useState({
    sourceId: "manual",
    title: "",
    url: "",
    manualPrice: "",
    steamAppId: "",
    idealoUrl: "",
  });

  const runCollectNow = async () => {
    setRunning(true);
    const id = notifications.show({
      loading: true,
      title: "Collecte en cours",
      message: "Interrogation de toutes les sources actives…",
      autoClose: false,
      withCloseButton: false,
    });
    try {
      const results = await admin.collectNow({});
      const collected = results.reduce((sum, row) => sum + row.collected, 0);
      const created = results.reduce((sum, row) => sum + row.created, 0);
      const failures = results.filter((row) => row.error);

      const [nextStats, nextProducts, nextRuns] = await Promise.all([
        admin.stats({}),
        productsClient.listProducts({ query: {} }),
        admin.runs({ query: { size: 20 } }),
      ]);
      setStats(nextStats as AdminStats);
      setProducts(nextProducts as TrackedProduct[]);
      setRuns(nextRuns as CollectionRun[]);

      notifications.update({
        id,
        loading: false,
        autoClose: 6000,
        withCloseButton: true,
        color: failures.length > 0 ? "orange" : "signal",
        icon: <Icon name={failures.length > 0 ? "alert" : "check"} size={16} />,
        title:
          failures.length > 0
            ? `Collecte terminée avec ${failures.length} erreur(s)`
            : "Collecte terminée",
        message: `${collected} offres récupérées, ${created} nouvelles.`,
      });
    } catch {
      notifications.update({
        id,
        loading: false,
        autoClose: 8000,
        withCloseButton: true,
        color: "red",
        icon: <Icon name="alert" size={16} />,
        title: "La collecte a échoué",
        message: "Consultez les journaux du serveur pour le détail.",
      });
    } finally {
      setRunning(false);
    }
  };

  const addProduct = async (event: FormEvent) => {
    event.preventDefault();
    try {
      const created = await productsClient.create({
        body: {
          sourceId: form.sourceId,
          title: form.title,
          url: form.url,
          manualPrice: form.manualPrice ? Number(form.manualPrice) : undefined,
          steamAppId: form.steamAppId ? Number(form.steamAppId) : undefined,
          idealoUrl: form.idealoUrl || undefined,
        },
      });
      setProducts([...products, created as TrackedProduct]);
      setForm({
        sourceId: "manual",
        title: "",
        url: "",
        manualPrice: "",
        steamAppId: "",
        idealoUrl: "",
      });
      notifications.show({
        message: "Produit ajouté au suivi",
        color: "signal",
        icon: <Icon name="check" size={16} />,
      });
    } catch {
      notifications.show({
        title: "Ajout impossible",
        message: "Vérifiez l'URL et la source choisie.",
        color: "red",
      });
    }
  };

  const updateManualPrice = async (id: string, value: string) => {
    if (!value) return;
    const updated = await productsClient.updateManualPrice({
      params: { id },
      body: { manualPrice: Number(value) },
    });
    setProducts(
      products.map((product) =>
        product.id === id ? (updated as TrackedProduct) : product,
      ),
    );
    setStats((await admin.stats({})) as AdminStats);
    notifications.show({
      message: "Prix enregistré, collecte relancée pour cette source",
      color: "signal",
    });
  };

  const updateIdealoUrl = async (id: string, value: string) => {
    const updated = await productsClient.updateIdealoUrl({
      params: { id },
      body: { idealoUrl: value || undefined },
    });
    setProducts(
      products.map((product) =>
        product.id === id ? (updated as TrackedProduct) : product,
      ),
    );
    notifications.show({
      message: "Référence Idealo enregistrée",
      color: "signal",
    });
  };

  return (
    <Stack gap="xl">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <Stack gap={2}>
          <Title order={1} fz="1.75rem">
            Administration
          </Title>
          <Text fz="sm" c="dimmed">
            État des sources, des collectes et du catalogue suivi.
          </Text>
        </Stack>
        <Button
          loading={running}
          onClick={() => void runCollectNow()}
          leftSection={<Icon name="play" size={15} />}
        >
          Lancer une collecte
        </Button>
      </Group>

      <SimpleGrid cols={{ base: 2, md: 5 }} spacing="md">
        <StatTile label="Offres actives" value={stats.activeDeals} icon="tag" />
        <StatTile
          label="Offres expirées"
          value={stats.expiredDeals}
          icon="clock"
        />
        <StatTile
          label="Brouillons à relire"
          value={stats.draftsPending}
          icon="inbox"
        />
        <StatTile
          label="Produits suivis"
          value={stats.trackedProducts}
          icon="package"
        />
        <StatTile
          label="Relevés de prix"
          value={f.compactNumber(stats.priceObservations)}
          icon="chart"
        />
      </SimpleGrid>

      <Section
        title="Sources"
        description="Une source en erreur cesse silencieusement d'alimenter le catalogue : c'est le premier endroit à regarder quand les offres ne bougent plus."
      >
        <Paper p={0} style={{ overflow: "hidden" }}>
          <Table.ScrollContainer minWidth={620}>
            <Table verticalSpacing="sm" highlightOnHover>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Source</Table.Th>
                  <Table.Th>État</Table.Th>
                  <Table.Th>Dernière exécution</Table.Th>
                  <Table.Th>Dernier succès</Table.Th>
                  <Table.Th>Dernière erreur</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {stats.sources.map((source) => {
                  const health = sourceHealth(source);
                  return (
                    <Table.Tr key={source.id}>
                      <Table.Td fw={600}>{source.name}</Table.Td>
                      <Table.Td>
                        <Badge variant="light" color={health.color}>
                          {health.label}
                        </Badge>
                      </Table.Td>
                      <Table.Td c="dimmed">
                        {source.lastRunAt ? f.dateTime(source.lastRunAt) : "—"}
                      </Table.Td>
                      <Table.Td c="dimmed">
                        {source.lastSuccessAt
                          ? f.relativeTime(source.lastSuccessAt)
                          : "—"}
                      </Table.Td>
                      <Table.Td>
                        {source.lastError ? (
                          <Tooltip
                            label={source.lastError}
                            multiline
                            w={320}
                            withArrow
                          >
                            <Text fz="sm" c="red" lineClamp={1} maw={220}>
                              {source.lastError}
                            </Text>
                          </Tooltip>
                        ) : (
                          <Text c="dimmed">—</Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Paper>
      </Section>

      <Section
        title="Historique des collectes"
        description="Exécutions du job « deals.collect », telles qu'enregistrées par l'ordonnanceur."
      >
        {runs.length === 0 ? (
          <EmptyState
            icon="clock"
            title="Aucune collecte enregistrée"
            description="Le job n'a pas encore tourné. Lancez-en une manuellement pour vérifier la configuration des sources."
          />
        ) : (
          <Paper p={0} style={{ overflow: "hidden" }}>
            <Table.ScrollContainer minWidth={620}>
              <Table verticalSpacing="sm" highlightOnHover>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th w={32} />
                    <Table.Th>Démarrée</Table.Th>
                    <Table.Th>Statut</Table.Th>
                    <Table.Th>Durée</Table.Th>
                    <Table.Th>Tentative</Table.Th>
                    <Table.Th>Déclenchée par</Table.Th>
                    <Table.Th>Erreur</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {runs.map((run) => {
                    const status = RUN_STATUS[run.status] ?? {
                      label: f.titleize(run.status),
                      color: "gray",
                    };
                    const isExpanded = expandedRunId === run.id;
                    const hasLogs = run.logs.length > 0;
                    return (
                      <Fragment key={run.id}>
                        <Table.Tr>
                          <Table.Td>
                            {hasLogs ? (
                              <ActionIcon
                                variant="subtle"
                                color="gray"
                                aria-label={
                                  isExpanded
                                    ? "Masquer le détail"
                                    : "Afficher le détail"
                                }
                                onClick={() =>
                                  setExpandedRunId(isExpanded ? null : run.id)
                                }
                              >
                                <Icon
                                  name={
                                    isExpanded ? "chevronDown" : "chevronRight"
                                  }
                                  size={16}
                                />
                              </ActionIcon>
                            ) : null}
                          </Table.Td>
                          <Table.Td>
                            {run.startedAt ? f.dateTime(run.startedAt) : "—"}
                          </Table.Td>
                          <Table.Td>
                            <Badge variant="light" color={status.color}>
                              {status.label}
                            </Badge>
                          </Table.Td>
                          <Table.Td className="tnum">
                            {f.duration(run.durationMs)}
                          </Table.Td>
                          <Table.Td className="tnum">{run.attempt}</Table.Td>
                          <Table.Td c="dimmed">
                            {run.triggeredBy ?? "—"}
                          </Table.Td>
                          <Table.Td>
                            {run.error ? (
                              <Tooltip
                                label={run.error}
                                multiline
                                w={320}
                                withArrow
                              >
                                <Text fz="sm" c="red" lineClamp={1} maw={200}>
                                  {run.error}
                                </Text>
                              </Tooltip>
                            ) : (
                              <Text c="dimmed">—</Text>
                            )}
                          </Table.Td>
                        </Table.Tr>
                        {isExpanded && hasLogs ? (
                          <Table.Tr key={`${run.id}-detail`}>
                            <Table.Td />
                            <Table.Td colSpan={6} p={0}>
                              <Stack gap={0} py="xs" px="md" bg="dark.8">
                                {run.logs.map((entry, index) => {
                                  const level = LOG_LEVEL[entry.level] ?? {
                                    label: entry.level,
                                    color: "gray",
                                  };
                                  const detail = describeLogData(entry.data);
                                  return (
                                    <Group
                                      key={index}
                                      gap="sm"
                                      py={6}
                                      wrap="nowrap"
                                      align="flex-start"
                                    >
                                      <Text
                                        fz="xs"
                                        c="dimmed"
                                        className="tnum"
                                        w={150}
                                        style={{ flexShrink: 0 }}
                                      >
                                        {f.dateTime(new Date(entry.timestamp))}
                                      </Text>
                                      <Badge
                                        variant="light"
                                        color={level.color}
                                        size="sm"
                                        w={110}
                                        style={{ flexShrink: 0 }}
                                      >
                                        {level.label}
                                      </Badge>
                                      <Text fz="sm">
                                        {entry.message}
                                        {detail ? (
                                          <Text
                                            component="span"
                                            c="dimmed"
                                            fz="sm"
                                          >
                                            {" "}
                                            ({detail})
                                          </Text>
                                        ) : null}
                                      </Text>
                                    </Group>
                                  );
                                })}
                              </Stack>
                            </Table.Td>
                          </Table.Tr>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          </Paper>
        )}
      </Section>

      <Grid gap="md">
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Section
            title="Produits suivis"
            description="Surveillés individuellement, en plus des offres découvertes automatiquement."
          >
            {products.length === 0 ? (
              <EmptyState
                icon="package"
                title="Aucun produit suivi"
                description="Ajoutez une URL produit pour suivre son prix dans la durée, même si elle n'apparaît dans aucune offre."
              />
            ) : (
              <Paper p={0} style={{ overflow: "hidden" }}>
                <Table.ScrollContainer minWidth={520}>
                  <Table verticalSpacing="sm">
                    <Table.Thead>
                      <Table.Tr>
                        <Table.Th>Produit</Table.Th>
                        <Table.Th>Source</Table.Th>
                        <Table.Th w={190}>Prix relevé</Table.Th>
                        <Table.Th w={220}>Référence Idealo</Table.Th>
                      </Table.Tr>
                    </Table.Thead>
                    <Table.Tbody>
                      {products.map((product) => (
                        <Table.Tr key={product.id}>
                          <Table.Td>
                            <Text
                              component="a"
                              href={product.url}
                              target="_blank"
                              rel="noopener noreferrer nofollow"
                              fz="sm"
                              fw={500}
                              lineClamp={1}
                              maw={260}
                            >
                              {product.title}
                            </Text>
                          </Table.Td>
                          <Table.Td c="dimmed" fz="sm">
                            {f.titleize(product.sourceId)}
                          </Table.Td>
                          <Table.Td>
                            <ManualPriceField
                              defaultValue={product.manualPrice}
                              onSubmit={(value) =>
                                void updateManualPrice(product.id, value)
                              }
                            />
                          </Table.Td>
                          <Table.Td>
                            <IdealoUrlField
                              defaultValue={product.idealoUrl}
                              referencePrice={product.idealoReferencePrice}
                              onSubmit={(value) =>
                                void updateIdealoUrl(product.id, value)
                              }
                            />
                          </Table.Td>
                        </Table.Tr>
                      ))}
                    </Table.Tbody>
                  </Table>
                </Table.ScrollContainer>
              </Paper>
            )}
          </Section>
        </Grid.Col>

        <Grid.Col span={{ base: 12, lg: 5 }}>
          <Section title="Ajouter un produit">
            <Card p="md" component="form" onSubmit={addProduct}>
              <Stack gap="sm">
                <TextInput
                  label="Titre"
                  required
                  value={form.title}
                  onChange={(event) =>
                    setForm({ ...form, title: event.currentTarget.value })
                  }
                />
                <TextInput
                  label="URL du produit"
                  required
                  type="url"
                  placeholder="https://…"
                  value={form.url}
                  onChange={(event) =>
                    setForm({ ...form, url: event.currentTarget.value })
                  }
                />
                <TextInput
                  label="Source"
                  description={`Identifiants disponibles : ${sources.map((source) => source.id).join(", ")}`}
                  required
                  value={form.sourceId}
                  onChange={(event) =>
                    setForm({ ...form, sourceId: event.currentTarget.value })
                  }
                />
                <Group grow>
                  <NumberInput
                    label="Prix relevé"
                    description="Sources manuelles"
                    suffix=" €"
                    min={0}
                    decimalScale={2}
                    value={form.manualPrice}
                    onChange={(value) =>
                      setForm({ ...form, manualPrice: String(value ?? "") })
                    }
                  />
                  <NumberInput
                    label="App ID Steam"
                    description="Source Steam"
                    min={0}
                    value={form.steamAppId}
                    onChange={(value) =>
                      setForm({ ...form, steamAppId: String(value ?? "") })
                    }
                  />
                </Group>
                <TextInput
                  label="Page Idealo (optionnel)"
                  description="Prix de référence marché, utilisé pour le scoring"
                  type="url"
                  placeholder="https://www.idealo.fr/prix/…"
                  value={form.idealoUrl}
                  onChange={(event) =>
                    setForm({ ...form, idealoUrl: event.currentTarget.value })
                  }
                />
                <Button type="submit" mt="xs">
                  Ajouter au suivi
                </Button>
              </Stack>
            </Card>
          </Section>
        </Grid.Col>
      </Grid>
    </Stack>
  );
};

/**
 * Price entry that only commits on blur or Enter.
 *
 * Saving on every keystroke would re-run the collector for the source on
 * each digit typed — the one action on this page with a real cost.
 */
const ManualPriceField: FC<{
  defaultValue?: number;
  onSubmit: (value: string) => void;
}> = ({ defaultValue, onSubmit }) => {
  const [value, setValue] = useState(
    defaultValue === undefined ? "" : String(defaultValue),
  );

  return (
    <NumberInput
      size="xs"
      suffix=" €"
      min={0}
      decimalScale={2}
      placeholder="—"
      value={value}
      onChange={(next) => setValue(String(next ?? ""))}
      onBlur={() => value !== String(defaultValue ?? "") && onSubmit(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSubmit(value);
        }
      }}
      aria-label="Prix relevé manuellement"
    />
  );
};

/**
 * Idealo page URL entry that only commits on blur or Enter, same rationale
 * as {@link ManualPriceField}. Shows the last cached reference price (if
 * any) as a hint — the fetch itself only happens lazily on the next
 * collection run, not from this form.
 */
const IdealoUrlField: FC<{
  defaultValue?: string;
  referencePrice?: number;
  onSubmit: (value: string) => void;
}> = ({ defaultValue, referencePrice, onSubmit }) => {
  const [value, setValue] = useState(defaultValue ?? "");

  return (
    <Stack gap={2}>
      <TextInput
        size="xs"
        type="url"
        placeholder="https://www.idealo.fr/prix/…"
        value={value}
        onChange={(event) => setValue(event.currentTarget.value)}
        onBlur={() => value !== (defaultValue ?? "") && onSubmit(value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit(value);
          }
        }}
        aria-label="Page Idealo de référence"
      />
      {referencePrice !== undefined ? (
        <Text c="dimmed" fz="xs">
          Référence : {referencePrice.toFixed(2)} €
        </Text>
      ) : null}
    </Stack>
  );
};

export default AdminPage;
