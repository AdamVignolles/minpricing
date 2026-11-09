import {
  Chip,
  Group,
  Pagination,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useRouter } from "alepha/react/router";
import type { FC } from "react";

import DealGrid from "../components/deals/DealGrid.tsx";
import AddedLinksList from "../components/links/AddedLinksList.tsx";
import AddLinkField from "../components/links/AddLinkField.tsx";
import Icon from "../components/ui/Icon.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import type { DealsPage, RefItem } from "../types.ts";

type WatchStatus = "waiting" | "price_drop" | "published" | "on_dealabs";

export interface HandAddedQuery {
  sortBy?: string;
  status?: WatchStatus;
  page?: number;
}

export interface HandAddedPageProps {
  dealsPage: DealsPage;
  merchants: RefItem[];
  /** How many products have each status (epic 33). */
  counts: Record<WatchStatus | "all", number>;
  query: HandAddedQuery;
}

/** The status filters, in the order the owner asked for. */
const FILTERS: Array<{ value: WatchStatus | "all"; label: string }> = [
  { value: "all", label: "Tous" },
  { value: "price_drop", label: "Baisse de prix" },
  { value: "published", label: "Publié" },
  { value: "on_dealabs", label: "Déjà sur Dealabs" },
  { value: "waiting", label: "Pas intéressant" },
];

const EMPTY: Record<WatchStatus, string> = {
  price_drop:
    "Aucune vraie baisse de prix pour l'instant. Les produits sont relus chaque jour : ils passent ici dès qu'une vraie promotion apparaît.",
  published: "Aucun de vos ajouts n'est publié et en ligne sur Dealabs.",
  on_dealabs: "Aucun de vos ajouts n'est déjà en ligne sur Dealabs.",
  waiting: "Aucun produit en attente d'une baisse de prix.",
};

const SORTS = [
  { value: "newest", label: "Plus récents" },
  { value: "relevance", label: "Pertinence" },
  { value: "hot", label: "Potentiel Dealabs" },
  { value: "discount", label: "Réduction décroissante" },
  { value: "price-asc", label: "Prix croissant" },
  { value: "price-desc", label: "Prix décroissant" },
];

const buildHref = (query: HandAddedQuery): string => {
  const params = new URLSearchParams();
  if (query.sortBy && query.sortBy !== "newest") {
    params.set("sortBy", query.sortBy);
  }
  if (query.status) params.set("status", query.status);
  if (query.page) params.set("page", String(query.page));
  const qs = params.toString();
  return qs ? `/ajouts?${qs}` : "/ajouts";
};

/**
 * « Mes ajouts »: the deals added by hand (pasted links), kept out of
 * « Bons plans ». The add field, their cards, and every link's last check
 * with its actions (Revérifier, Arrêter, Retirer).
 */
const HandAddedPage: FC<HandAddedPageProps> = ({
  dealsPage,
  merchants,
  counts,
  query,
}) => {
  const router = useRouter();
  const total = dealsPage.page.totalElements ?? dealsPage.content.length;
  const size = dealsPage.page.size || 24;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = (dealsPage.page.number ?? 0) + 1;

  return (
    <Stack gap="lg">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="sm">
        <Stack gap={2}>
          <Title order={1} fz="1.75rem">
            Mes ajouts
          </Title>
          <Text fz="sm" c="dimmed" className="tnum">
            {counts.all} produit{counts.all > 1 ? "s" : ""} ajouté
            {counts.all > 1 ? "s" : ""} à la main et surveillé
            {counts.all > 1 ? "s" : ""} chaque jour
          </Text>
        </Stack>
        <Select
          w={210}
          data={SORTS}
          value={query.sortBy ?? "newest"}
          onChange={(value) =>
            void router.push(
              buildHref({
                sortBy: value ?? undefined,
                status: query.status,
                page: undefined,
              }),
            )
          }
          leftSection={<Icon name="sortDesc" size={15} />}
          aria-label="Trier mes ajouts"
          allowDeselect={false}
        />
      </Group>

      <AddLinkField />

      {counts.all > 0 ? (
        <Chip.Group
          multiple={false}
          value={query.status ?? "all"}
          onChange={(value) =>
            void router.push(
              buildHref({
                sortBy: query.sortBy,
                status: value === "all" ? undefined : (value as WatchStatus),
              }),
            )
          }
        >
          <Group gap={8} wrap="wrap" aria-label="Filtrer mes ajouts par statut">
            {FILTERS.map((filter) => (
              <Chip
                key={filter.value}
                value={filter.value}
                variant="light"
                color={filter.value === "price_drop" ? "signal" : "gray"}
                className="tnum"
              >
                {filter.label} · {counts[filter.value]}
              </Chip>
            ))}
          </Group>
        </Chip.Group>
      ) : null}

      {dealsPage.content.length === 0 ? (
        query.status ? (
          <EmptyState
            icon="link"
            title={`Aucun produit « ${FILTERS.find((f) => f.value === query.status)?.label} »`}
            description={EMPTY[query.status]}
          />
        ) : (
          <EmptyState
            icon="link"
            title="Aucun bon plan ajouté à la main"
            description="Collez le lien d'une fiche produit (Amazon, Cdiscount, AliExpress, Steam) dans le champ ci-dessus : il est surveillé chaque jour, même s'il n'est pas en promotion, et passe en « Baisse de prix » dès qu'une vraie promotion apparaît."
          />
        )
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

      <Stack gap="xs">
        <Title order={2} fz="1.15rem">
          Liens et vérifications
        </Title>
        <Text fz="sm" c="dimmed">
          Chaque lien est relu toutes les heures pendant 14 jours (et tant qu'il
          est en « Baisse de prix »), puis une fois par jour, jusqu'à ce que
          vous le retiriez ou l'arrêtiez. Seules les vraies baisses comptent :
          jamais un prix conseillé, ni un prix auquel le produit revient
          régulièrement.
        </Text>
        <AddedLinksList />
      </Stack>
    </Stack>
  );
};

export default HandAddedPage;
