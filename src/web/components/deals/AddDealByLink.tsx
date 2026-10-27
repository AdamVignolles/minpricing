import {
  Alert,
  Badge,
  Button,
  Group,
  Image,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { useClient } from "alepha/react";
import { useRouter } from "alepha/react/router";
import { type FC, useState } from "react";

import type { DealsController } from "../../../api/controllers/DealsController.ts";
import * as f from "../ui/format.ts";
import Icon from "../ui/Icon.tsx";

type Preview = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof useClient<DealsController>>["previewLink"]>
  >["preview"]
>;

/** "Ajouter un deal" button + modal: paste a link, check the card, save. */
export const AddDealByLink: FC = () => {
  const deals = useClient<DealsController>();
  const router = useRouter();
  const [opened, { open, close }] = useDisclosure(false);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [error, setError] = useState<string>();

  const reset = () => {
    setUrl("");
    setPreview(undefined);
    setError(undefined);
    close();
  };

  const check = async () => {
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    try {
      const response = await deals.previewLink({ body: { url } });
      setPreview(response.preview);
      setError(response.error);
    } finally {
      setBusy(false);
    }
  };

  const save = async (force: boolean) => {
    setBusy(true);
    try {
      const response = await deals.addFromLink({ body: { url, force } });
      if (response.dealId) {
        reset();
        void router.push(`/deals/${response.dealId}`);
      } else {
        setError(response.message ?? "Le deal n'a pas pu être ajouté.");
      }
    } finally {
      setBusy(false);
    }
  };

  const discount =
    preview?.listPrice && preview.listPrice > preview.price
      ? Math.round(
          ((preview.listPrice - preview.price) / preview.listPrice) * 100,
        )
      : undefined;

  return (
    <>
      <Button
        variant="default"
        leftSection={<Icon name="external" size={16} />}
        onClick={open}
      >
        Ajouter un deal
      </Button>
      <Modal
        opened={opened}
        onClose={reset}
        title="Ajouter un deal par lien"
        size="lg"
      >
        <Stack gap="md">
          <Group gap="sm" wrap="nowrap" align="flex-end">
            <TextInput
              flex={1}
              label="Lien du produit"
              placeholder="https://…"
              value={url}
              onChange={(event) => setUrl(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && url.trim() && !busy) void check();
              }}
            />
            <Button
              onClick={() => void check()}
              loading={busy}
              disabled={!url.trim()}
            >
              Vérifier
            </Button>
          </Group>

          {error && (
            <Alert color="red" icon={<Icon name="alert" size={16} />}>
              {error}
            </Alert>
          )}

          {preview && (
            <Stack gap="sm">
              <Group wrap="nowrap" align="flex-start" gap="md">
                {preview.imageUrl && (
                  <Image
                    src={preview.imageUrl}
                    w={96}
                    h={96}
                    fit="contain"
                    alt=""
                  />
                )}
                <Stack gap={4}>
                  <Text fw={600}>{preview.title}</Text>
                  <Group gap="xs">
                    <Text fw={700} c="signal" className="tnum">
                      {f.price(preview.price, preview.currency)}
                    </Text>
                    {discount !== undefined && (
                      <Badge color="signal" variant="light">
                        -{discount} % par rapport au prix barré
                      </Badge>
                    )}
                    <Badge variant="default">{preview.sourceId}</Badge>
                  </Group>
                </Stack>
              </Group>
              {preview.existingDealId && (
                <Alert color="blue">
                  Ce produit est déjà suivi : l'ajouter met à jour le deal
                  existant.
                </Alert>
              )}
              {preview.qualityIssue && (
                <Alert color="yellow" icon={<Icon name="alert" size={16} />}>
                  Filtre qualité : {preview.qualityIssue}. Tu peux l'ajouter
                  quand même.
                </Alert>
              )}
              <Group justify="flex-end">
                <Button
                  onClick={() => void save(Boolean(preview.qualityIssue))}
                  loading={busy}
                  color={preview.qualityIssue ? "yellow" : undefined}
                >
                  {preview.qualityIssue
                    ? "Ajouter quand même"
                    : "Ajouter le deal"}
                </Button>
              </Group>
            </Stack>
          )}
        </Stack>
      </Modal>
    </>
  );
};

export default AddDealByLink;
