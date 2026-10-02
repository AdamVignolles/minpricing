import { Button, Paper, Stack, Text, ThemeIcon } from "@mantine/core";
import type { FC, ReactNode } from "react";

import Icon, { type IconName } from "./Icon.tsx";

export interface EmptyStateProps {
  icon?: IconName;
  title: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  children?: ReactNode;
}

/**
 * Shown whenever a query legitimately returns nothing.
 *
 * An empty screen is a failure of explanation, not of data: each use gets a
 * title that names *what* is missing and a description that says what to do
 * about it, so the user never has to guess whether the app is broken.
 */
export const EmptyState: FC<EmptyStateProps> = ({
  icon = "inbox",
  title,
  description,
  action,
  children,
}) => (
  <Paper p="xl" style={{ borderStyle: "dashed" }}>
    <Stack align="center" gap="xs" py="lg">
      <ThemeIcon variant="light" color="gray" size={48} radius="xl">
        <Icon name={icon} size={22} />
      </ThemeIcon>
      <Text fw={600}>{title}</Text>
      {description ? (
        <Text fz="sm" c="dimmed" ta="center" maw={420}>
          {description}
        </Text>
      ) : null}
      {action ? (
        <Button mt="xs" variant="light" onClick={action.onClick}>
          {action.label}
        </Button>
      ) : null}
      {children}
    </Stack>
  </Paper>
);

export interface ErrorStateProps {
  title?: string;
  description?: string;
  onRetry?: () => void;
}

/** The counterpart to `EmptyState` for a request that actually failed. */
export const ErrorState: FC<ErrorStateProps> = ({
  title = "Impossible de charger ces données",
  description = "La requête a échoué. Les données affichées peuvent être incomplètes.",
  onRetry,
}) => (
  <Paper
    p="lg"
    withBorder
    style={{ borderColor: "var(--mantine-color-red-7)" }}
  >
    <Stack align="center" gap="xs">
      <ThemeIcon variant="light" color="red" size={44} radius="xl">
        <Icon name="alert" size={20} />
      </ThemeIcon>
      <Text fw={600}>{title}</Text>
      <Text fz="sm" c="dimmed" ta="center" maw={420}>
        {description}
      </Text>
      {onRetry ? (
        <Button
          mt="xs"
          variant="light"
          color="red"
          leftSection={<Icon name="refresh" size={15} />}
          onClick={onRetry}
        >
          Réessayer
        </Button>
      ) : null}
    </Stack>
  </Paper>
);
