import { Group, Paper, Stack, Text, Tooltip } from "@mantine/core";
import type { FC, ReactNode } from "react";

import Icon, { type IconName } from "./Icon.tsx";

export interface StatTileProps {
  label: string;
  value: ReactNode;
  hint?: string;
  icon?: IconName;
  /** Shown when the underlying data is genuinely absent. */
  empty?: boolean;
  accent?: boolean;
}

/**
 * A single headline figure.
 *
 * The value is the only thing with weight; the label sits above it in small
 * dimmed text. When a metric has no data we say so in words instead of
 * printing a zero, because "0 €" and "we never observed a reference price"
 * are very different statements to a user reading a dashboard.
 */
const StatTile: FC<StatTileProps> = ({
  label,
  value,
  hint,
  icon,
  empty,
  accent,
}) => {
  const body = (
    <Paper p="md" h="100%">
      <Stack gap={4}>
        <Group gap={6} wrap="nowrap">
          {icon ? (
            <Icon
              name={icon}
              size={14}
              color="var(--mantine-color-dimmed)"
              aria-hidden
            />
          ) : null}
          <Text fz="xs" c="dimmed" fw={500} truncate>
            {label}
          </Text>
        </Group>
        {empty ? (
          <Text fz="sm" c="dimmed" fs="italic">
            Pas encore de données
          </Text>
        ) : (
          <Text
            fz="1.6rem"
            fw={700}
            lh={1.1}
            className="tnum"
            c={accent ? "signal.6" : undefined}
          >
            {value}
          </Text>
        )}
        {hint && !empty ? (
          <Text fz="xs" c="dimmed">
            {hint}
          </Text>
        ) : null}
      </Stack>
    </Paper>
  );

  return hint && empty ? (
    <Tooltip label={hint} withArrow>
      {body}
    </Tooltip>
  ) : (
    body
  );
};

export default StatTile;
