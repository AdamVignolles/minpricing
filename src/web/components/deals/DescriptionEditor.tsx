import {
  Badge,
  Box,
  Group,
  Paper,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { type FC, useMemo } from "react";

import { descriptionHtml } from "../../../api/services/descriptionHtml.ts";
import type { Draft } from "../../types.ts";
import * as f from "../ui/format.ts";

export interface DescriptionEditorProps {
  draft: Draft;
  onChange: (description: string) => void;
}

/** Who wrote the text the post will carry (#131). */
function authorBadge(draft: Draft) {
  if (draft.editedBy === "owner") {
    return (
      <Badge variant="light" color="blue">
        Votre texte{draft.editedAt ? ` · ${f.dateTime(draft.editedAt)}` : ""}
      </Badge>
    );
  }
  if (draft.editedBy?.startsWith("agent:")) {
    return (
      <Badge variant="light" color="grape">
        Écrit par l'agent {draft.editedBy.slice("agent:".length)}
      </Badge>
    );
  }
  return (
    <Badge variant="light" color="gray">
      Générée
      {draft.templateVersion && draft.templateVersion !== "legacy"
        ? ` · modèle ${draft.templateVersion}`
        : draft.templateVersion === "legacy"
          ? " · texte du marchand"
          : ""}
    </Badge>
  );
}

/**
 * The Dealabs description: the text to edit on one side, the post as
 * Dealabs will show it on the other (same `descriptionHtml` as the
 * publisher, so the preview is what gets posted). Stacked on a phone.
 */
const DescriptionEditor: FC<DescriptionEditorProps> = ({ draft, onChange }) => {
  const text = draft.description ?? "";
  // Built by `descriptionHtml`, which escapes every character of the text
  // and only emits p / strong / ul / li / br.
  const html = useMemo(() => descriptionHtml(text), [text]);
  return (
    <Stack gap="xs">
      <Group justify="space-between" gap="xs">
        <Text fz="sm" fw={500}>
          Description
        </Text>
        {authorBadge(draft)}
      </Group>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="md">
        <Textarea
          aria-label="Description du deal"
          description="« - » en début de ligne pour une liste, une ligne finissant par « : » juste avant une liste devient un titre en gras."
          autosize
          minRows={8}
          maxRows={24}
          value={text}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
        <Paper withBorder p="md" radius="md">
          <Text fz="xs" c="dimmed" mb="xs">
            Aperçu tel que sur Dealabs
          </Text>
          <Box
            fz="sm"
            style={{ lineHeight: 1.55, overflowWrap: "anywhere" }}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: escaped by descriptionHtml
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </Paper>
      </SimpleGrid>
    </Stack>
  );
};

export default DescriptionEditor;
