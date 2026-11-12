import {
  ActionIcon,
  Box,
  Button,
  Group,
  Loader,
  PasswordInput,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core";
import { useClient } from "alepha/react";
import {
  type FC,
  type FormEvent,
  type MouseEvent,
  type WheelEvent,
  useEffect,
  useRef,
  useState,
} from "react";

import type { DraftsController } from "../../../api/controllers/DraftsController.ts";
import Icon from "../ui/Icon.tsx";

interface Screen {
  active: boolean;
  label?: string;
  url?: string;
  image?: string;
  width: number;
  height: number;
}

type Key = "Enter" | "Tab" | "Backspace" | "Escape";

/**
 * « Écran distant »: the Dealabs window the server has open (login or
 * publishing), drawn here so you can act on it from the console — click
 * on the picture, type in the field below. Used when that window is on
 * the VM, which has no screen of its own. Polls once a second while
 * mounted; renders nothing when no window is open.
 */
const RemoteScreen: FC<{ hint?: string }> = ({ hint }) => {
  const drafts = useClient<DraftsController>();
  const [screen, setScreen] = useState<Screen | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      if (!busy.current) {
        try {
          const next = (await drafts.dealabsScreen({})) as Screen;
          if (!cancelled) setScreen(next);
        } catch {
          // Keep the last picture.
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 1_000);
    }
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [drafts]);

  const send = async (body: {
    gesture?: {
      trail: { x: number; y: number; dt: number }[];
      x: number;
      y: number;
      hold: number;
    };
    scroll?: number;
    text?: string;
    key?: Key;
  }) => {
    busy.current = true;
    setSending(true);
    try {
      setScreen((await drafts.dealabsScreenInput({ body })) as Screen);
    } catch {
      // The window just closed (login saved, publish done): next poll says so.
    } finally {
      busy.current = false;
      setSending(false);
    }
  };

  // Your pointer's recent path over the picture and when the button went
  // down: sent with the click, so the server's window sees the gesture you
  // made rather than a pointer that jumps onto the target.
  const trail = useRef<{ x: number; y: number; at: number }[]>([]);
  const pressedAt = useRef<number | null>(null);

  const toWindow = (event: MouseEvent<HTMLImageElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * (screen?.width ?? 0),
      y: ((event.clientY - box.top) / box.height) * (screen?.height ?? 0),
    };
  };

  const onMove = (event: MouseEvent<HTMLImageElement>) => {
    const now = performance.now();
    trail.current.push({ ...toWindow(event), at: now });
    // Three seconds of path is plenty.
    while (trail.current.length > 1 && now - trail.current[0].at > 3_000) {
      trail.current.shift();
    }
  };

  const onDown = () => {
    pressedAt.current = performance.now();
  };

  const onClick = (event: MouseEvent<HTMLImageElement>) => {
    if (!screen) return;
    const now = performance.now();
    const points = trail.current;
    trail.current = [];
    const hold = pressedAt.current === null ? 0 : now - pressedAt.current;
    pressedAt.current = null;
    void send({
      gesture: {
        trail: points.map((point, index) => ({
          x: point.x,
          y: point.y,
          dt: index === 0 ? 0 : point.at - points[index - 1].at,
        })),
        ...toWindow(event),
        hold,
      },
    });
  };

  const onWheel = (event: WheelEvent<HTMLImageElement>) => {
    void send({ scroll: event.deltaY });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!text) return;
    const value = text;
    setText("");
    void send({ text: value });
  };

  if (!screen?.active) return null;

  return (
    <Paper withBorder p="sm" radius="md">
      <Stack gap="xs">
        <Group justify="space-between" gap="xs">
          <Group gap={6}>
            <Icon name="eye" size={16} />
            <Text fz="sm" fw={600}>
              Écran distant · {screen.label ?? "Dealabs"}
            </Text>
            {sending ? <Loader size={12} /> : null}
          </Group>
          {screen.url ? (
            <Text fz="xs" c="dimmed" truncate maw={360}>
              {screen.url}
            </Text>
          ) : null}
        </Group>
        <Text fz="xs" c="dimmed">
          {hint ??
            "Cliquez directement sur l'image, et tapez dans le champ ci-dessous (email, mot de passe, code)."}
        </Text>
        <Box
          style={{
            position: "relative",
            aspectRatio: `${screen.width} / ${screen.height}`,
            border: "1px solid var(--mantine-color-default-border)",
            borderRadius: 6,
            overflow: "hidden",
            cursor: "pointer",
            background: "var(--mantine-color-default-hover)",
          }}
        >
          {screen.image ? (
            <img
              src={screen.image}
              alt="Fenêtre Dealabs du serveur"
              onClick={onClick}
              onMouseMove={onMove}
              onMouseDown={onDown}
              onWheel={onWheel}
              draggable={false}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
          ) : (
            <Group justify="center" h="100%">
              <Loader size="sm" />
            </Group>
          )}
        </Box>
        <form onSubmit={onSubmit}>
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <PasswordInput
              flex={1}
              size="xs"
              label="Texte à envoyer dans le champ sélectionné"
              placeholder="Cliquez d'abord sur un champ dans l'image"
              value={text}
              onChange={(event) => setText(event.currentTarget.value)}
              autoComplete="off"
            />
            <Button size="xs" type="submit" disabled={!text}>
              Envoyer
            </Button>
          </Group>
        </form>
        <Group gap={6}>
          {(
            [
              ["Enter", "Entrée"],
              ["Tab", "Tab"],
              ["Backspace", "Effacer"],
              ["Escape", "Échap"],
            ] as const
          ).map(([key, label]) => (
            <Button
              key={key}
              size="compact-xs"
              variant="default"
              onClick={() => void send({ key })}
            >
              {label}
            </Button>
          ))}
          <Tooltip label="Rafraîchir l'image">
            <ActionIcon
              size="sm"
              variant="default"
              onClick={() => void send({})}
              aria-label="Rafraîchir l'image"
            >
              <Icon name="refresh" size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Stack>
    </Paper>
  );
};

export default RemoteScreen;
