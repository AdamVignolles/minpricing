import {
  Alert,
  Button,
  CloseButton,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { type FC, type FormEvent, useState } from "react";

import type {
  LinkView,
  LinksController,
} from "../../../api/controllers/LinksController.ts";
import { SUPPORTED_SHOPS } from "../../../api/services/linkResolver.ts";
import Icon from "../ui/Icon.tsx";
import { LinkCheck } from "./LinkCheck.tsx";

const SHOP_LIST = SUPPORTED_SHOPS.map((shop) => shop.label).join(", ");

/**
 * « Ajouter un lien »: paste a product page link, nothing else to fill.
 * The link is checked like any collected offer (steps shown live), then
 * the deal or the reason it isn't one.
 */
const AddLinkField: FC = () => {
  const client = useClient<LinksController>();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string>();
  const [checking, setChecking] = useState<{
    link: LinkView;
    duplicate: boolean;
    /** Restarts the live view when the same link is pasted again. */
    attempt: number;
  }>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!url.trim()) return;
    setBusy(true);
    setRefusal(undefined);
    try {
      const result = await client.addLink({ body: { url: url.trim() } });
      if (result.ok && result.link) {
        setChecking((previous) => ({
          link: result.link as LinkView,
          duplicate: !!result.duplicate,
          attempt: (previous?.attempt ?? 0) + 1,
        }));
        setUrl("");
      } else {
        setChecking(undefined);
        setRefusal(result.message ?? "Lien refusé.");
      }
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap="sm">
        <form onSubmit={(event) => void submit(event)}>
          <Group gap="sm" wrap="nowrap" align="flex-start">
            <TextInput
              flex={1}
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              placeholder="Coller le lien d'une fiche produit…"
              aria-label="Ajouter un bon plan par son lien"
              leftSection={<Icon name="link" size={16} />}
              description={`Boutiques acceptées : ${SHOP_LIST}. Le produit passe les mêmes contrôles que les offres collectées.`}
              inputMode="url"
            />
            <Button type="submit" loading={busy} disabled={!url.trim()}>
              Ajouter
            </Button>
          </Group>
        </form>
        {refusal ? (
          <Alert
            color="orange"
            variant="light"
            icon={<Icon name="alert" size={16} />}
            withCloseButton
            onClose={() => setRefusal(undefined)}
          >
            {refusal}
          </Alert>
        ) : null}
        {checking ? (
          <Stack gap="xs">
            <Group justify="space-between" gap="xs">
              <Text fz="sm" fw={600}>
                {checking.duplicate
                  ? "Lien déjà suivi : nouvelle vérification"
                  : "Vérification du lien"}
              </Text>
              <CloseButton
                size="sm"
                aria-label="Fermer"
                onClick={() => setChecking(undefined)}
              />
            </Group>
            <LinkCheck
              key={`${checking.link.id}-${checking.attempt}`}
              initial={checking.link}
            />
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
};

export default AddLinkField;
