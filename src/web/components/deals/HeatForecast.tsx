import {
  Badge,
  Group,
  Paper,
  Progress,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import type { FC } from "react";

import type { HeatLabel, HeatPrediction } from "../../types.ts";

/**
 * Heat colours: Dealabs' own cold→hot scale, deliberately not the `signal`
 * accent (reserved for price information). The tier is always written
 * out too, so colour is never the only carrier.
 */
export const HEAT: Record<HeatLabel, { label: string; color: string }> = {
  chaud: { label: "Chaud", color: "red" },
  prometteur: { label: "Prometteur", color: "orange" },
  tiède: { label: "Tiède", color: "yellow" },
  froid: { label: "Froid", color: "blue" },
};

/** Small badge for cards: "🔥 34 %". */
export const HeatBadge: FC<{ chance?: number | null }> = ({ chance }) => {
  if (chance === undefined || chance === null) return null;
  const tier = HEAT[heatLabel(chance)];
  return (
    <Tooltip
      label={`${tier.label} : ${chance} % de chances d'atteindre 100° sur Dealabs (estimation)`}
      withArrow
    >
      <Badge
        size="sm"
        variant="light"
        color={tier.color}
        className="tnum"
        style={{ flexShrink: 0 }}
      >
        🔥 {chance} %
      </Badge>
    </Tooltip>
  );
};

export function heatLabel(chance: number): HeatLabel {
  return chance >= 60
    ? "chaud"
    : chance >= 35
      ? "prometteur"
      : chance >= 15
        ? "tiède"
        : "froid";
}

/** The detail page's "Prévision Dealabs" block. */
const HeatForecast: FC<{ heat: HeatPrediction }> = ({ heat }) => {
  const tier = HEAT[heat.label];
  return (
    <Paper p="sm" withBorder>
      <Stack gap={6}>
        <Group justify="space-between" gap="xs">
          <Text fw={600} fz="sm">
            Prévision Dealabs
          </Text>
          <Badge variant="light" color={tier.color}>
            {tier.label} · {heat.chance} % de chances d'atteindre 100°
          </Badge>
        </Group>
        <Progress
          value={heat.chance}
          color={tier.color}
          size="sm"
          aria-label={`${heat.chance} % de chances d'atteindre 100°`}
        />
        {heat.reasons.length > 0 ? (
          <Stack gap={2}>
            {heat.reasons.map((reason) => (
              <Text key={reason} fz="xs" c="dimmed">
                • {reason}
              </Text>
            ))}
          </Stack>
        ) : (
          <Text fz="xs" c="dimmed">
            Pas d'historique Dealabs pour ce produit : estimation sur la
            catégorie, la baisse réelle et le prix seulement.
          </Text>
        )}
        <Text fz="xs" c="dimmed">
          Estimation à partir de ~2 000 deals Dealabs et de vos propres
          publications. Indicatif : la température dépend aussi du moment et de
          la description.
        </Text>
      </Stack>
    </Paper>
  );
};

export default HeatForecast;
