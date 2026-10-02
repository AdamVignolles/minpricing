import { Card, SimpleGrid, Skeleton, Stack } from "@mantine/core";
import type { FC } from "react";

import type { Deal, RefItem } from "../../types.ts";
import DealCard from "./DealCard.tsx";

/** Shared breakpoints: changing the density of the grid happens in one place. */
export const GRID_COLS = { base: 1, xs: 2, sm: 2, md: 3, lg: 4 } as const;

/**
 * Mirrors a `DealCard`'s real proportions.
 *
 * A skeleton that is the wrong height is worse than none: the page settles
 * with a jump the moment data arrives, which reads as a bug.
 */
export const DealCardSkeleton: FC = () => (
  <Card padding="md">
    <Card.Section p="sm" pb={0}>
      <Skeleton style={{ aspectRatio: "4 / 3" }} radius="md" />
    </Card.Section>
    <Stack gap={8} mt="sm">
      <Skeleton h={12} radius="sm" />
      <Skeleton h={12} w="70%" radius="sm" />
      <Skeleton h={22} w="45%" radius="sm" mt={4} />
      <Skeleton h={10} w="55%" radius="sm" />
    </Stack>
  </Card>
);

export interface DealGridProps {
  deals: Deal[];
  merchants?: RefItem[];
  /** How many cards are assumed above the fold and loaded eagerly. */
  priorityCount?: number;
}

const DealGrid: FC<DealGridProps> = ({
  deals,
  merchants,
  priorityCount = 4,
}) => (
  <SimpleGrid cols={GRID_COLS} spacing="md" verticalSpacing="md">
    {deals.map((deal, index) => (
      <DealCard
        key={deal.id}
        deal={deal}
        merchants={merchants}
        priority={index < priorityCount}
      />
    ))}
  </SimpleGrid>
);

export const DealGridSkeleton: FC<{ count?: number }> = ({ count = 8 }) => (
  <SimpleGrid cols={GRID_COLS} spacing="md" verticalSpacing="md">
    {Array.from({ length: count }, (_, index) => (
      <DealCardSkeleton key={index} />
    ))}
  </SimpleGrid>
);

export default DealGrid;
