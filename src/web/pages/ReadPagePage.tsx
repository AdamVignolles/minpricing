import {
  Alert,
  Anchor,
  Button,
  Group,
  Loader,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useClient } from "alepha/react";
import { Link } from "alepha/react/router";
import { type FC, useEffect, useRef, useState } from "react";

import type { LinksController } from "../../api/controllers/LinksController.ts";
import Icon from "../components/ui/Icon.tsx";

/** What the `/lire` loader hands over: the watched links (and the gate). */
export interface ReadPageProps {
  links: Array<{
    id: string;
    externalId: string;
    sourceId: string;
    status: string;
  }>;
}

/** The only pages the button may send (`readSentPage` checks it again). */
const AMAZON_ORIGIN = /^https:\/\/(www\.)?amazon\.fr$/;
/** Comfortably under the server's 5 MB file part. */
const MAX_BYTES = 4_500_000;

const asinOf = (url: string): string | undefined =>
  url
    .match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?=[/?#]|$)/i)?.[1]
    ?.toUpperCase();

/** Scripts and styles off when a page is too large to send whole. */
const slim = (html: string): string => {
  if (html.length <= MAX_BYTES) return html;
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll(
    "script, style, noscript, svg, iframe, link",
  )) {
    el.remove();
  }
  return `<!doctype html>${doc.documentElement.outerHTML}`;
};

type State =
  | { step: "waiting" }
  | { step: "no-opener" }
  | { step: "sending"; asin: string }
  | {
      step: "done";
      verdict: string;
      dealId?: string;
      status: string;
    }
  | { step: "error"; message: string };

/**
 * « Lire dans DealRadar » (epic 33). Opened by the bookmarklet from an
 * Amazon.fr product page the owner is looking at: it asks that tab for
 * the page (`postMessage`, origin checked both ways) and sends it with the
 * owner's session to `POST /links/:id/page-read`, which reads it with the
 * collection's own parser. The server never asks Amazon anything here.
 */
const ReadPagePage: FC<ReadPageProps> = ({ links }) => {
  const client = useClient<LinksController>();
  const [state, setState] = useState<State>({ step: "waiting" });
  const handled = useRef(false);

  useEffect(() => {
    const opener = window.opener as Window | null;
    if (!opener) {
      const timer = window.setTimeout(() => setState({ step: "no-opener" }), 0);
      return () => window.clearTimeout(timer);
    }

    const send = async (url: string, html: string) => {
      const asin = asinOf(url);
      if (!asin) {
        setState({
          step: "error",
          message:
            "Ce n'est pas une fiche produit Amazon.fr (pas d'ASIN dans l'adresse).",
        });
        return;
      }
      setState({ step: "sending", asin });
      try {
        let link = links.find(
          (l) =>
            l.sourceId === "amazon" &&
            l.externalId === asin &&
            l.status !== "removed",
        );
        if (!link) {
          // Not watched yet: added first, like the « Ajouter » field.
          const added = await client.addLink({
            body: { url: `https://www.amazon.fr/dp/${asin}` },
          });
          if (!added.ok || !added.link) {
            throw new Error(added.message ?? "Lien refusé.");
          }
          link = added.link;
        }
        const form = new FormData();
        form.append("url", url);
        form.append(
          "page",
          new Blob([slim(html)], { type: "text/html" }),
          "page.html",
        );
        const response = await fetch(`/api/links/${link.id}/page-read`, {
          method: "POST",
          body: form,
          credentials: "same-origin",
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(
            body?.message ?? `Lecture refusée (${response.status}).`,
          );
        }
        setState({
          step: "done",
          verdict: body.verdict ?? "Lu.",
          dealId: body.deal?.id,
          status: body.status,
        });
      } catch (error) {
        setState({
          step: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (!AMAZON_ORIGIN.test(event.origin) || event.source !== opener) {
        return;
      }
      const data = event.data as
        | { type?: string; url?: string; html?: string }
        | undefined;
      if (data?.type !== "dealradar-page" || handled.current) return;
      if (typeof data.url !== "string" || typeof data.html !== "string") {
        return;
      }
      handled.current = true;
      void send(data.url, data.html);
    };
    window.addEventListener("message", onMessage);
    // « Ready » until the Amazon tab answers (it carries no data).
    const ready = () => opener.postMessage({ type: "dealradar-ready" }, "*");
    ready();
    const timer = window.setInterval(() => {
      if (handled.current) window.clearInterval(timer);
      else ready();
    }, 500);
    const giveUp = window.setTimeout(() => {
      if (!handled.current) {
        window.clearInterval(timer);
        setState({
          step: "error",
          message:
            "La fiche Amazon n'a pas répondu. Relancez le bouton depuis la fiche produit.",
        });
      }
    }, 15_000);
    return () => {
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      window.clearTimeout(giveUp);
    };
  }, [client, links]);

  return (
    <Stack gap="md" maw={640}>
      <Title order={1} fz="1.6rem">
        Lire dans DealRadar
      </Title>
      {state.step === "waiting" ? (
        <Group gap="sm">
          <Loader size="sm" />
          <Text>En attente de la fiche Amazon…</Text>
        </Group>
      ) : null}
      {state.step === "sending" ? (
        <Group gap="sm">
          <Loader size="sm" />
          <Text>
            Lecture de la fiche {state.asin} : prix, vendeur, avis, puis les
            mêmes contrôles qu'une offre collectée…
          </Text>
        </Group>
      ) : null}
      {state.step === "no-opener" ? (
        <Alert color="gray" icon={<Icon name="link" size={16} />}>
          Cette page s'ouvre depuis le bouton « Lire dans DealRadar », cliqué
          sur une fiche produit Amazon.fr. Installez-le depuis{" "}
          <Anchor component={Link} href="/ajouts">
            Mes ajouts
          </Anchor>
          .
        </Alert>
      ) : null}
      {state.step === "error" ? (
        <Alert color="red" icon={<Icon name="alert" size={16} />}>
          {state.message}
        </Alert>
      ) : null}
      {state.step === "done" ? (
        <Stack gap="sm">
          <Alert
            color={state.status === "failed" ? "red" : "gray"}
            icon={<Icon name="check" size={16} />}
            title="Fiche lue depuis votre navigateur"
          >
            {state.verdict}
          </Alert>
          <Group gap="sm">
            {state.dealId ? (
              <Button component={Link} href={`/deals/${state.dealId}`}>
                Voir le deal
              </Button>
            ) : null}
            <Button variant="default" component={Link} href="/ajouts">
              Mes ajouts
            </Button>
            <Button variant="subtle" onClick={() => window.close()}>
              Fermer
            </Button>
          </Group>
        </Stack>
      ) : null}
    </Stack>
  );
};

export default ReadPagePage;
