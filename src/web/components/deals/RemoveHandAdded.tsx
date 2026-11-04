import { ActionIcon, Button, Group, Modal, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { notifications } from "@mantine/notifications";
import { useClient } from "alepha/react";
import { useRouter } from "alepha/react/router";
import { type FC, type MouseEvent, useState } from "react";

import type { DealsController } from "../../../api/controllers/DealsController.ts";
import Icon from "../ui/Icon.tsx";

export interface RemoveHandAddedProps {
  dealId: string;
  title: string;
  /** `icon` on cards, a labelled button on the detail page. */
  variant?: "icon" | "button";
  /** Called once removed, after the page's data is reloaded. */
  onRemoved?: () => void;
}

/**
 * « Retirer des ajouts à la main »: stops watching the deal's pasted link.
 * The deal is not deleted — it stays only if regular collection finds it
 * and it passes the usual checks.
 */
const RemoveHandAdded: FC<RemoveHandAddedProps> = ({
  dealId,
  title,
  variant = "icon",
  onRemoved,
}) => {
  const client = useClient<DealsController>();
  const router = useRouter();
  const [opened, modal] = useDisclosure(false);
  const [busy, setBusy] = useState(false);

  const open = (event: MouseEvent) => {
    // On a card the trigger sits inside the card's link.
    event.preventDefault();
    event.stopPropagation();
    modal.open();
  };

  const confirm = async () => {
    setBusy(true);
    try {
      await client.removeHandAdded({ params: { id: dealId } });
      modal.close();
      notifications.show({
        color: "teal",
        title: "Retiré des ajouts à la main",
        message: "Son lien n'est plus surveillé.",
      });
      await router.invalidate();
      onRemoved?.();
    } catch (error) {
      notifications.show({
        color: "red",
        title: "Impossible de retirer ce bon plan",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    // React events bubble through the modal's portal: stop them here so a
    // click in the modal never reaches the card's link.
    <span onClick={(event) => event.stopPropagation()}>
      {variant === "icon" ? (
        <Tooltip label="Retirer des ajouts à la main" withArrow>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            aria-label="Retirer des ajouts à la main"
            onClick={open}
            style={{ flexShrink: 0 }}
          >
            <Icon name="close" size={13} />
          </ActionIcon>
        </Tooltip>
      ) : (
        <Button
          variant="default"
          color="red"
          size="xs"
          leftSection={<Icon name="close" size={14} />}
          onClick={open}
        >
          Retirer des ajouts à la main
        </Button>
      )}
      <Modal
        opened={opened}
        onClose={modal.close}
        title="Retirer des ajouts à la main ?"
        centered
      >
        <Text fz="sm" fw={500} mb="xs" lineClamp={2}>
          {title}
        </Text>
        <Text fz="sm" c="dimmed">
          Le lien n'est plus surveillé. L'offre reste visible seulement si la
          collecte normale la retrouve et qu'elle passe les contrôles.
        </Text>
        <Group justify="flex-end" mt="lg">
          <Button variant="default" onClick={modal.close} disabled={busy}>
            Annuler
          </Button>
          <Button color="red" loading={busy} onClick={confirm}>
            Retirer
          </Button>
        </Group>
      </Modal>
    </span>
  );
};

export default RemoveHandAdded;
