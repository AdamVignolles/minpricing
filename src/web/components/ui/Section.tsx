import { Anchor, Group, Stack, Text, Title } from "@mantine/core";
import { Link } from "alepha/react/router";
import type { FC, ReactNode } from "react";

import Icon from "./Icon.tsx";

export interface SectionProps {
  title: string;
  description?: string;
  /** Renders a "see all" affordance aligned with the heading. */
  moreHref?: string;
  moreLabel?: string;
  action?: ReactNode;
  children: ReactNode;
}

/**
 * A titled block of content.
 *
 * Exists so every section on every page shares one heading rhythm — the
 * cheapest way to make a multi-page app feel like a single product.
 */
const Section: FC<SectionProps> = ({
  title,
  description,
  moreHref,
  moreLabel = "Tout voir",
  action,
  children,
}) => (
  <Stack gap="sm">
    <Group justify="space-between" align="flex-end" wrap="nowrap" gap="sm">
      <Stack gap={2} style={{ minWidth: 0 }}>
        <Title order={2} fz="lg">
          {title}
        </Title>
        {description ? (
          <Text fz="sm" c="dimmed">
            {description}
          </Text>
        ) : null}
      </Stack>
      {action ??
        (moreHref ? (
          <Anchor
            component={Link}
            href={moreHref}
            fz="sm"
            fw={600}
            style={{ whiteSpace: "nowrap" }}
          >
            <Group gap={4} wrap="nowrap" component="span">
              {moreLabel}
              <Icon name="chevronRight" size={15} aria-hidden />
            </Group>
          </Anchor>
        ) : null)}
    </Group>
    {children}
  </Stack>
);

export default Section;
