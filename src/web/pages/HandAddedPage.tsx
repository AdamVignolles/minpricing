import { Group, Pagination, Select, Stack, Text, Title } from "@mantine/core";
import { useRouter } from "alepha/react/router";
import type { FC } from "react";

import DealGrid from "../components/deals/DealGrid.tsx";
import AddedLinksList from "../components/links/AddedLinksList.tsx";
import AddLinkField from "../components/links/AddLinkField.tsx";
import Icon from "../components/ui/Icon.tsx";
import { EmptyState } from "../components/ui/States.tsx";
import type { DealsPage, RefItem } from "../types.ts";

export interface HandAddedQuery {
  sortBy?: string;
  page?: number;
}

export interface HandAddedPageProps {
  dealsPage: DealsPage;
  merchants: RefItem[];
  query: HandAddedQuery;
}

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
            {total} bon{total > 1 ? "s" : ""} plan{total > 1 ? "s" : ""} ajouté
            {total > 1 ? "s" : ""} à la main, même mal noté
            {total > 1 ? "s" : ""}
          </Text>
        </Stack>
        <Select
          w={210}
          data={SORTS}
          value={query.sortBy ?? "newest"}
          onChange={(value) =>
            void router.push(
              buildHref({ sortBy: value ?? undefined, page: undefined }),
            )
          }
          leftSection={<Icon name="sortDesc" size={15} />}
          aria-label="Trier mes ajouts"
          allowDeselect={false}
        />
      </Group>

      <AddLinkField />

      {dealsPage.content.length === 0 ? (
        <EmptyState
          icon="link"
          title="Aucun bon plan ajouté à la main"
          description="Collez le lien d'une fiche produit (Amazon, Cdiscount, AliExpress, Steam) dans le champ ci-dessus : il est vérifié comme une offre collectée, puis apparaît ici."
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

      <Stack gap="xs">
        <Title order={2} fz="1.15rem">
          Liens et vérifications
        </Title>
        <Text fz="sm" c="dimmed">
          Chaque lien est relu à chaque collecte (toutes les heures) pendant 14
          jours, ou jusqu'à l'expiration du bon plan.
        </Text>
        <AddedLinksList />
      </Stack>
    </Stack>
  );
};

export default HandAddedPage;
