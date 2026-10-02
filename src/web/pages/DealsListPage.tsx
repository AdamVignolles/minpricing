import {
  Badge,
  Box,
  Button,
  Chip,
  CloseButton,
  Drawer,
  Grid,
  Group,
  NumberInput,
  Pagination,
  Paper,
  Radio,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useDebouncedValue, useDisclosure } from "@mantine/hooks";
import { useRouter } from "alepha/react/router";
import { type FC, useEffect, useMemo, useState } from "react";

import DealGrid from "../components/deals/DealGrid.tsx";
import * as f from "../components/ui/format.ts";
import Icon from "../components/ui/Icon.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import type { DealsPage, RefItem } from "../types.ts";

export interface DealsQuery {
  page?: number;
  search?: string;
  sortBy?: string;
  categoryId?: string;
  merchantId?: string;
  sourceId?: string;
  minDiscount?: number;
  minPrice?: number;
  maxPrice?: number;
}

export interface DealsPageProps {
  dealsPage: DealsPage;
  categories: RefItem[];
  merchants: RefItem[];
  sources: RefItem[];
  query: DealsQuery;
}

const SORTS = [
  { value: "relevance", label: "Pertinence" },
  { value: "discount", label: "Réduction décroissante" },
  { value: "price-asc", label: "Prix croissant" },
  { value: "price-desc", label: "Prix décroissant" },
  { value: "newest", label: "Plus récents" },
];

/**
 * Discount thresholds, not an open-ended slider.
 *
 * "More than 30 %" is a decision a user can make instantly; "34 %" is one
 * they have to invent. Buckets also keep the URL short and shareable.
 */
const DISCOUNT_STEPS = [10, 20, 30, 50, 70];

const PRICE_RANGES = [
  { label: "Moins de 20 €", min: undefined, max: 20 },
  { label: "20 – 50 €", min: 20, max: 50 },
  { label: "50 – 100 €", min: 50, max: 100 },
  { label: "100 – 500 €", min: 100, max: 500 },
  { label: "Plus de 500 €", min: 500, max: undefined },
];

const buildHref = (query: DealsQuery): string => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === "" || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `/deals?${qs}` : "/deals";
};

const labelFor = (rows: RefItem[], id: string | undefined) =>
  rows.find((row) => row.id === id)?.name ?? (id ? f.titleize(id) : "");

const DealsListPage: FC<DealsPageProps> = ({
  dealsPage,
  categories,
  merchants,
  sources,
  query,
}) => {
  const router = useRouter();
  const [drawerOpened, drawer] = useDisclosure(false);
  const [search, setSearch] = useState(query.search ?? "");
  const [debouncedSearch] = useDebouncedValue(search, 350);

  /**
   * Keeps the box in sync when the URL changes from outside it — the back
   * button, a category link, "clear all". Adjusting state during render is
   * React's documented alternative to a synchronising effect: it re-renders
   * immediately instead of painting the stale value first.
   */
  const [urlSearch, setUrlSearch] = useState(query.search ?? "");
  if (urlSearch !== (query.search ?? "")) {
    setUrlSearch(query.search ?? "");
    setSearch(query.search ?? "");
  }

  /**
   * Any filter change resets to page 0 — staying on page 4 of a result set
   * that now has two pages is the classic way to show a user an empty screen
   * and make them think the app lost their data.
   */
  const apply = (patch: Partial<DealsQuery>) => {
    void router.push(buildHref({ ...query, page: undefined, ...patch }));
  };

  // Typing drives navigation, but only once the user pauses, and never when
  // the URL already says what the box says (back-button and first render).
  useEffect(() => {
    const next = debouncedSearch.trim();
    if (next === (query.search ?? "")) return;
    void router.push(
      buildHref({ ...query, page: undefined, search: next || undefined }),
    );
  }, [debouncedSearch]);

  const activeChips = useMemo(() => {
    const chips: Array<{ label: string; clear: Partial<DealsQuery> }> = [];
    if (query.search) {
      chips.push({
        label: `« ${query.search} »`,
        clear: { search: undefined },
      });
    }
    if (query.categoryId) {
      chips.push({
        label: labelFor(categories, query.categoryId),
        clear: { categoryId: undefined },
      });
    }
    if (query.merchantId) {
      chips.push({
        label: labelFor(merchants, query.merchantId),
        clear: { merchantId: undefined },
      });
    }
    if (query.sourceId) {
      chips.push({
        label: `Source : ${labelFor(sources, query.sourceId)}`,
        clear: { sourceId: undefined },
      });
    }
    if (query.minDiscount) {
      chips.push({
        label: `≥ ${query.minDiscount} %`,
        clear: { minDiscount: undefined },
      });
    }
    if (query.minPrice !== undefined || query.maxPrice !== undefined) {
      const min = query.minPrice;
      const max = query.maxPrice;
      chips.push({
        label:
          min !== undefined && max !== undefined
            ? `${min} – ${max} €`
            : min !== undefined
              ? `≥ ${min} €`
              : `≤ ${max} €`,
        clear: { minPrice: undefined, maxPrice: undefined },
      });
    }
    return chips;
  }, [query, categories, merchants, sources]);

  const total = dealsPage.page.totalElements ?? dealsPage.content.length;
  const size = dealsPage.page.size || 20;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = (dealsPage.page.number ?? 0) + 1;

  const filters = (
    <Stack gap="lg">
      <Stack gap="xs">
        <Text fw={600} fz="sm">
          Réduction minimale
        </Text>
        <Group gap={6}>
          {DISCOUNT_STEPS.map((step) => (
            <Chip
              key={step}
              size="sm"
              checked={query.minDiscount === step}
              onChange={() =>
                apply({
                  minDiscount: query.minDiscount === step ? undefined : step,
                })
              }
            >
              ≥ {step} %
            </Chip>
          ))}
        </Group>
      </Stack>

      <Stack gap="xs">
        <Text fw={600} fz="sm">
          Prix
        </Text>
        <Radio.Group
          value={String(
            PRICE_RANGES.findIndex(
              (range) =>
                range.min === query.minPrice && range.max === query.maxPrice,
            ),
          )}
          onChange={(value) => {
            const range = PRICE_RANGES[Number(value)];
            apply({ minPrice: range?.min, maxPrice: range?.max });
          }}
        >
          <Stack gap={6}>
            {PRICE_RANGES.map((range, index) => (
              <Radio
                key={range.label}
                value={String(index)}
                label={range.label}
                size="xs"
              />
            ))}
          </Stack>
        </Radio.Group>
        <Group gap="xs" grow>
          <NumberInput
            size="xs"
            placeholder="Min"
            suffix=" €"
            min={0}
            value={query.minPrice ?? ""}
            onChange={(value) =>
              apply({ minPrice: value === "" ? undefined : Number(value) })
            }
            aria-label="Prix minimum"
          />
          <NumberInput
            size="xs"
            placeholder="Max"
            suffix=" €"
            min={0}
            value={query.maxPrice ?? ""}
            onChange={(value) =>
              apply({ maxPrice: value === "" ? undefined : Number(value) })
            }
            aria-label="Prix maximum"
          />
        </Group>
      </Stack>

      <Select
        label="Catégorie"
        placeholder="Toutes"
        clearable
        searchable
        value={query.categoryId ?? null}
        data={categories.map((row) => ({ value: row.id, label: row.name }))}
        onChange={(value) => apply({ categoryId: value ?? undefined })}
      />

      <Select
        label="Marchand"
        placeholder="Tous"
        clearable
        value={query.merchantId ?? null}
        data={merchants.map((row) => ({ value: row.id, label: row.name }))}
        onChange={(value) => apply({ merchantId: value ?? undefined })}
      />

      <Select
        label="Source"
        placeholder="Toutes"
        clearable
        value={query.sourceId ?? null}
        data={sources.map((row) => ({ value: row.id, label: row.name }))}
        onChange={(value) => apply({ sourceId: value ?? undefined })}
      />
    </Stack>
  );

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <Stack gap={2}>
          <Title order={1} fz="1.75rem">
            Bons plans
          </Title>
          <Text fz="sm" c="dimmed" className="tnum">
            {total} offre{total > 1 ? "s" : ""} correspondant à votre recherche
          </Text>
        </Stack>
      </Group>

      <Group gap="sm" wrap="nowrap">
        <TextInput
          flex={1}
          size="md"
          placeholder="Rechercher un produit, une marque…"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          leftSection={<Icon name="search" size={16} />}
          rightSection={
            search ? (
              <CloseButton
                size="sm"
                onClick={() => setSearch("")}
                aria-label="Effacer la recherche"
              />
            ) : null
          }
          aria-label="Rechercher un bon plan"
        />
        <Select
          size="md"
          w={190}
          visibleFrom="sm"
          data={SORTS}
          value={query.sortBy ?? "newest"}
          onChange={(value) => apply({ sortBy: value ?? undefined })}
          leftSection={<Icon name="sortDesc" size={15} />}
          aria-label="Trier les résultats"
          allowDeselect={false}
        />
        <Button
          size="md"
          variant="default"
          hiddenFrom="md"
          onClick={drawer.open}
          leftSection={<Icon name="filter" size={16} />}
        >
          Filtres
          {activeChips.length > 0 ? (
            <Badge size="xs" ml={6} circle>
              {activeChips.length}
            </Badge>
          ) : null}
        </Button>
      </Group>

      {activeChips.length > 0 ? (
        <Group gap={6}>
          {activeChips.map((chip) => (
            <Badge
              key={chip.label}
              variant="light"
              color="gray"
              size="lg"
              rightSection={
                <CloseButton
                  size={14}
                  iconSize={12}
                  onClick={() => apply(chip.clear)}
                  aria-label={`Retirer le filtre ${chip.label}`}
                />
              }
            >
              {chip.label}
            </Badge>
          ))}
          <Button
            variant="subtle"
            size="compact-sm"
            color="gray"
            onClick={() => void router.push("/deals")}
          >
            Tout effacer
          </Button>
        </Group>
      ) : null}

      <Grid gap="lg">
        <Grid.Col span={{ base: 12, md: 3 }} visibleFrom="md">
          <Paper p="md" pos="sticky" top={72}>
            {filters}
          </Paper>
        </Grid.Col>
        <Grid.Col span={{ base: 12, md: 9 }}>
          {dealsPage.content.length === 0 ? (
            <EmptyState
              icon="search"
              title="Aucune offre ne correspond"
              description="Essayez d'élargir la fourchette de prix, de baisser la réduction minimale, ou de retirer un filtre."
              action={{
                label: "Réinitialiser les filtres",
                onClick: () => void router.push("/deals"),
              }}
            />
          ) : (
            <Stack gap="lg">
              <DealGrid deals={dealsPage.content} merchants={merchants} />
              {totalPages > 1 ? (
                <Group justify="center">
                  <Pagination
                    total={totalPages}
                    value={current}
                    onChange={(value) =>
                      void router.push(
                        buildHref({
                          ...query,
                          page: value > 1 ? value - 1 : undefined,
                        }),
                      )
                    }
                    withEdges
                  />
                </Group>
              ) : null}
            </Stack>
          )}
        </Grid.Col>
      </Grid>

      <Drawer
        opened={drawerOpened}
        onClose={drawer.close}
        title="Filtres"
        position="bottom"
        size="85%"
        scrollAreaComponent={ScrollArea.Autosize}
      >
        <Box pb="xl">
          {filters}
          <Select
            mt="lg"
            label="Trier par"
            data={SORTS}
            value={query.sortBy ?? "newest"}
            onChange={(value) => apply({ sortBy: value ?? undefined })}
            allowDeselect={false}
          />
          <Button fullWidth mt="lg" onClick={drawer.close}>
            Voir les {total} résultats
          </Button>
        </Box>
      </Drawer>
    </Stack>
  );
};

export default DealsListPage;
