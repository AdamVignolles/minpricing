import {
  Anchor,
  Group,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
  Title,
  UnstyledButton,
} from "@mantine/core";
import { type FC, useState } from "react";

import Icon from "../ui/Icon.tsx";

/**
 * Keepa's chart through our own server (`KeepaController`): Keepa refuses
 * it to pages that embed it from another site.
 */
function chartUrl(asin: string, days: string, size: "small" | "large") {
  return `/api/keepa/${asin}?range=${days}&size=${size}`;
}

const RANGES = [
  { value: "30", label: "30 jours" },
  { value: "90", label: "90 jours" },
  { value: "180", label: "6 mois" },
  { value: "365", label: "1 an" },
];

export interface KeepaChartProps {
  asin: string;
  /** Charting the same product found on Amazon, not the deal's own page. */
  sameProductOnAmazon: boolean;
  title: string;
}

/**
 * The deal page's Keepa panel: the 90-day chart, clickable to open a large
 * view with a choice of period and a link to the full history on Keepa.
 */
const KeepaChart: FC<KeepaChartProps> = ({
  asin,
  sameProductOnAmazon,
  title,
}) => {
  const [opened, setOpened] = useState(false);
  const [range, setRange] = useState("90");
  const heading = sameProductOnAmazon
    ? "Historique du prix sur Amazon (même produit)"
    : "Historique du prix Amazon";

  return (
    <Paper p="md" withBorder>
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Title order={5}>{heading}</Title>
          <Text fz="xs" c="dimmed">
            Keepa, 90 jours · cliquez pour agrandir
          </Text>
        </Group>
        <UnstyledButton
          onClick={() => setOpened(true)}
          aria-label="Agrandir la courbe de prix"
          style={{ cursor: "zoom-in" }}
        >
          <img
            src={chartUrl(asin, "90", "small")}
            alt={`Courbe de prix Keepa sur 90 jours : ${title}`}
            style={{ width: "100%", height: "auto", display: "block" }}
            loading="lazy"
          />
        </UnstyledButton>
        <Text fz="xs" c="dimmed">
          {sameProductOnAmazon
            ? "Prix d'Amazon pour le même produit, à titre de comparaison."
            : "Ajouté en tête de la description lors de la publication sur Dealabs."}
        </Text>
      </Stack>

      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={heading}
        size="xl"
        centered
      >
        <Stack gap="sm">
          <SegmentedControl
            value={range}
            onChange={setRange}
            data={RANGES}
            fullWidth
          />
          <img
            src={chartUrl(asin, range, "large")}
            alt={`Courbe de prix Keepa (${range} jours) : ${title}`}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
          <Anchor
            href={`https://keepa.com/#!product/4-${asin}`}
            target="_blank"
            rel="noreferrer"
            fz="sm"
          >
            <Group gap={4} component="span">
              Voir l'historique complet sur Keepa
              <Icon name="external" size={14} aria-hidden />
            </Group>
          </Anchor>
        </Stack>
      </Modal>
    </Paper>
  );
};

export default KeepaChart;
