import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { type FC, useState } from "react";

/** Dealabs refuses titles longer than this (`DEALABS_TITLE_MAX`). */
const MAX = 140;
const MIN = 10;

/**
 * Rename once (epic 28): the deal's name had to be cut to fit Dealabs'
 * 140 characters, so before its first publication the owner writes the
 * real Dealabs title here, prefilled with the shortened one. Validating
 * approves it (`POST /deals/:id/draft/title`), then the publish goes on.
 */
const DealabsTitleDialog: FC<{
  opened: boolean;
  /** The shortened (or agent-written) title to start from. */
  initial: string;
  /** The merchant's full name, for reference. */
  fullTitle: string;
  saving?: boolean;
  error?: string;
  onCancel: () => void;
  onValidate: (title: string) => void;
}> = ({ opened, initial, fullTitle, saving, error, onCancel, onValidate }) => {
  // The parent remounts it on each opening (`key`): starts from `initial`.
  const [title, setTitle] = useState(initial);
  const length = title.trim().length;
  const invalid = length < MIN || length > MAX;

  return (
    <Modal opened={opened} onClose={onCancel} title="Titre Dealabs" size="lg">
      <Stack gap="sm">
        <Text size="sm">
          Le nom du produit a dû être coupé pour tenir en {MAX} caractères.
          Écrivez le titre qui sera publié sur Dealabs : il sera gardé pour
          toutes les publications suivantes.
        </Text>
        <Text size="xs" c="dimmed" lineClamp={4}>
          Nom complet chez le marchand : {fullTitle}
        </Text>
        <TextInput
          label="Titre"
          data-autofocus
          value={title}
          maxLength={MAX}
          description={`${length} / ${MAX} caractères`}
          error={
            error ??
            (length > 0 && length < MIN
              ? `${MIN} caractères au moins.`
              : undefined)
          }
          onChange={(event) => setTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !invalid) onValidate(title.trim());
          }}
        />
        <Group justify="flex-end" gap="sm">
          <Button variant="default" onClick={onCancel}>
            Annuler
          </Button>
          <Button
            loading={saving}
            disabled={invalid}
            onClick={() => onValidate(title.trim())}
          >
            Valider le titre et publier
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};

export default DealabsTitleDialog;
