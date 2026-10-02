import {
  Box,
  Button,
  Center,
  MantineProvider,
  Paper,
  PasswordInput,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { useRouter } from "alepha/react/router";
import { type FC, type FormEvent, useState } from "react";

import type { AuthController } from "../../api/controllers/AuthController.ts";
import Icon from "../components/ui/Icon.tsx";
import { theme } from "../theme.ts";

/**
 * The only page reachable without a session (see `AppRouter.layout`'s
 * `errorHandler` — every other page's loader 401s and redirects here).
 * Submits straight to `AuthController#login`, which sets the signed
 * session cookie; every other page's loader then succeeds on the next
 * request.
 *
 * Deliberately NOT a child of `layout`: nesting it there would render it
 * inside `AppLayout`'s `AppShell`, sidebar included — a login screen has no
 * business showing navigation to pages the visitor can't reach yet. It
 * brings its own `MantineProvider` instead of inheriting the layout's.
 */
const LoginPage: FC = () => {
  const auth = useClient<AuthController>();
  const router = useRouter();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [submitting, setSubmitting] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(undefined);
    try {
      await auth.login({ body: { username, password } });
      await router.push("/");
    } catch {
      setError("Identifiants invalides.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <MantineProvider theme={theme} defaultColorScheme="dark">
      <Center mih="100vh">
        <Paper withBorder shadow="md" p="xl" radius="md" w={360}>
          <Stack gap="lg">
            <Box ta="center">
              <Box
                w={40}
                h={40}
                mx="auto"
                mb="sm"
                style={{
                  display: "grid",
                  placeItems: "center",
                  borderRadius: 10,
                  background: "var(--mantine-primary-color-filled)",
                  color: "var(--mantine-primary-color-contrast)",
                }}
              >
                <Icon name="bolt" size={20} strokeWidth={2.4} />
              </Box>
              <Title order={2} fz="h3">
                DealRadar
              </Title>
              <Text c="dimmed" fz="sm">
                Console privée — connectez-vous pour continuer.
              </Text>
            </Box>

            <form onSubmit={submit}>
              <Stack gap="md">
                <TextInput
                  label="Nom d'utilisateur"
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.currentTarget.value)}
                  required
                  autoFocus
                />
                <PasswordInput
                  label="Mot de passe"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.currentTarget.value)}
                  required
                />
                {error && (
                  <Text c="red" fz="sm">
                    {error}
                  </Text>
                )}
                <Button type="submit" fullWidth loading={submitting}>
                  Se connecter
                </Button>
              </Stack>
            </form>
          </Stack>
        </Paper>
      </Center>
    </MantineProvider>
  );
};

export default LoginPage;
