import {
  Alert,
  Badge,
  Button,
  Group,
  Image,
  Modal,
  NumberInput,
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

type Saved = Awaited<
  ReturnType<ReturnType<typeof useClient<DealsController>>["addFromLink"]>
>;

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
  const [needsManual, setNeedsManual] = useState(false);
  const [manual, setManual] = useState<{
    title: string;
    price: number | "";
    listPrice: number | "";
  }>({ title: "", price: "", listPrice: "" });
  const [saved, setSaved] = useState<Saved>();

  const reset = () => {
    setUrl("");
    setPreview(undefined);
    setError(undefined);
    setNeedsManual(false);
    setManual({ title: "", price: "", listPrice: "" });
    setSaved(undefined);
    close();
  };

  const manualEntry = () =>
    needsManual && manual.title && manual.price !== ""
      ? {
          title: manual.title,
          price: Number(manual.price),
          listPrice:
            manual.listPrice === "" ? undefined : Number(manual.listPrice),
        }
      : undefined;

  const check = async () => {
    setBusy(true);
    setError(undefined);
    setPreview(undefined);
    setSaved(undefined);
    try {
      const response = await deals.previewLink({
        body: { url, manual: manualEntry() },
      });
      setPreview(response.preview);
      setError(response.error);
      setNeedsManual(Boolean(response.needsManual));
    } finally {
      setBusy(false);
    }
  };

  const save = async (force: boolean) => {
    setBusy(true);
    try {
      const response = await deals.addFromLink({
        body: { url, force, manual: manualEntry() },
      });
      if (response.dealId) {
        setSaved(response);
        setPreview(undefined);
        setError(undefined);
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

          {needsManual && (
            <Stack gap="xs">
              <TextInput
                label="Titre"
                value={manual.title}
                onChange={(event) =>
                  setManual({ ...manual, title: event.currentTarget.value })
                }
              />
              <Group grow>
                <NumberInput
                  label="Prix (€)"
                  min={0}
                  decimalScale={2}
                  value={manual.price}
                  onChange={(value) =>
                    setManual({
                      ...manual,
                      price: value === "" ? "" : Number(value),
                    })
                  }
                />
                <NumberInput
                  label="Prix barré (€), optionnel"
                  min={0}
                  decimalScale={2}
                  value={manual.listPrice}
                  onChange={(value) =>
                    setManual({
                      ...manual,
                      listPrice: value === "" ? "" : Number(value),
                    })
                  }
                />
              </Group>
              <Text fz="xs" c="dimmed">
                Renseigne le prix puis clique sur « Vérifier » pour continuer.
              </Text>
            </Stack>
          )}

          {saved && (
            <Alert
              color={saved.visible ? "green" : "yellow"}
              title={
                saved.result === "created" ? "Deal ajouté" : "Deal mis à jour"
              }
            >
              <Stack gap="xs">
                <Text fz="sm">{saved.title}</Text>
                <Group gap="xs">
                  <Badge variant="default">Score {saved.score ?? 0}/100</Badge>
                  {saved.hotChance !== undefined && (
                    <Badge variant="default">
                      Chance d'atteindre 100° : {saved.hotChance} %
                    </Badge>
                  )}
                  <Badge variant="default">
                    {saved.hasDraft
                      ? "Brouillon Dealabs créé"
                      : "Pas de brouillon"}
                  </Badge>
                </Group>
                {!saved.visible && (
                  <Text fz="sm">
                    Score sous le seuil de visibilité : le deal est enregistré
                    mais masqué des listes.
                  </Text>
                )}
                <Group>
                  <Button
                    size="xs"
                    onClick={() => {
                      const id = saved.dealId;
                      reset();
                      void router.push(`/deals/${id}`);
                    }}
                  >
                    Ouvrir le deal{saved.hasDraft ? " et publier" : ""}
                  </Button>
                </Group>
              </Stack>
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
