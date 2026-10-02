import {
  ActionIcon,
  AppShell,
  Box,
  Burger,
  Group,
  MantineProvider,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { Notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { Link, NestedView, useActive, useRouter } from "alepha/react/router";
import type { FC } from "react";

import type { AuthController } from "../../../api/controllers/AuthController.ts";
import { theme } from "../../theme.ts";
import Icon, { type IconName } from "../ui/Icon.tsx";

/**
 * The five places the application can be. Keeping them in one array is what
 * guarantees the desktop rail and the mobile drawer can never drift apart.
 *
 * `exact` exists only for "/" — every other route is a prefix of its own
 * children, so a "starts with" match is what marks the right item active when
 * the user is deep inside a section.
 */
const NAV: Array<{
  href: string;
  label: string;
  icon: IconName;
  exact?: boolean;
}> = [
  { href: "/", label: "Tableau de bord", icon: "dashboard", exact: true },
  { href: "/deals", label: "Bons plans", icon: "tag" },
  { href: "/stats", label: "Statistiques", icon: "chart" },
  { href: "/admin", label: "Administration", icon: "settings" },
];

const NavItem: FC<{
  href: string;
  label: string;
  icon: IconName;
  exact?: boolean;
  onNavigate: () => void;
}> = ({ href, label, icon, exact, onNavigate }) => {
  const { isActive } = useActive({ href, startWith: !exact });

  return (
    <NavLink
      component={Link}
      href={href}
      label={label}
      active={isActive}
      onClick={onNavigate}
      // The rail is short enough that an icon alone would be a guessing game;
      // the icon is a landmark, the label is the actual affordance.
      leftSection={<Icon name={icon} size={18} aria-hidden />}
      aria-current={isActive ? "page" : undefined}
      variant="light"
      fw={isActive ? 600 : 500}
      py="xs"
    />
  );
};

/**
 * Clears the signed session cookie and sends the visitor back to `/login`.
 * A hard `router.push` (not just clearing local state) is required: every
 * other page's loader re-fetches on navigation, and without a valid
 * session those fetches now 401 — which is exactly what re-triggers the
 * `layout` page's `errorHandler` redirect, confirming the logout worked.
 */
const LogoutButton: FC = () => {
  const auth = useClient<AuthController>();
  const router = useRouter();

  const logout = async () => {
    try {
      await auth.logout({});
    } finally {
      await router.push("/login");
    }
  };

  return (
    <Tooltip label="Se déconnecter" withArrow>
      <ActionIcon
        onClick={logout}
        variant="default"
        size="lg"
        aria-label="Se déconnecter"
      >
        <Icon name="logout" size={18} />
      </ActionIcon>
    </Tooltip>
  );
};

const ColorSchemeToggle: FC = () => {
  const { colorScheme, toggleColorScheme } = useMantineColorScheme();
  const isDark = colorScheme === "dark";
  const label = isDark ? "Passer en thème clair" : "Passer en thème sombre";

  return (
    <Tooltip label={label} withArrow>
      <ActionIcon
        onClick={toggleColorScheme}
        variant="default"
        size="lg"
        aria-label={label}
      >
        <Icon name={isDark ? "sun" : "moon"} size={18} />
      </ActionIcon>
    </Tooltip>
  );
};

/**
 * Root layout. Every page renders inside it through `NestedView`, which is
 * why the provider lives here: Alepha's `rootComponents` render as *siblings*
 * of the page, so they cannot wrap it, and a layout route can.
 */
const AppLayout: FC = () => {
  const [opened, { toggle, close }] = useDisclosure(false);

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Notifications position="bottom-right" limit={3} />
      <AppShell
        header={{ height: 56 }}
        navbar={{
          width: 240,
          breakpoint: "sm",
          collapsed: { mobile: !opened },
        }}
        padding={{ base: "md", sm: "lg" }}
      >
        <AppShell.Header>
          <Group h="100%" px="md" justify="space-between" wrap="nowrap">
            <Group gap="sm" wrap="nowrap">
              <Burger
                opened={opened}
                onClick={toggle}
                hiddenFrom="sm"
                size="sm"
                aria-label="Ouvrir la navigation"
              />
              <Box
                component={Link}
                href="/"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <Box
                  w={26}
                  h={26}
                  style={{
                    display: "grid",
                    placeItems: "center",
                    borderRadius: 8,
                    background: "var(--mantine-primary-color-filled)",
                    color: "var(--mantine-primary-color-contrast)",
                  }}
                >
                  <Icon name="bolt" size={15} strokeWidth={2.4} />
                </Box>
                <Text fw={700} fz="lg" lh={1}>
                  DealRadar
                </Text>
              </Box>
            </Group>
            <Group gap="xs" wrap="nowrap">
              <ColorSchemeToggle />
              <LogoutButton />
            </Group>
          </Group>
        </AppShell.Header>

        <AppShell.Navbar p="xs">
          <AppShell.Section grow component={ScrollArea}>
            <Stack gap={2}>
              {NAV.map((item) => (
                <NavItem key={item.href} {...item} onNavigate={close} />
              ))}
            </Stack>
          </AppShell.Section>
          <AppShell.Section>
            <Text c="dimmed" fz="xs" p="xs">
              Console privée — données collectées automatiquement.
            </Text>
          </AppShell.Section>
        </AppShell.Navbar>

        <AppShell.Main>
          <NestedView />
        </AppShell.Main>
      </AppShell>
    </MantineProvider>
  );
};

export default AppLayout;
