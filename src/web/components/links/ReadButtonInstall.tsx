import { Anchor, Group, Paper, Stack, Text } from "@mantine/core";
import { type FC, useEffect, useRef } from "react";

import Icon from "../ui/Icon.tsx";

/**
 * The bookmarklet: on an Amazon.fr product page, opens DealRadar's `/lire`
 * and hands it the page once it says it is ready (origin checked both
 * ways). The page the owner is looking at goes to DealRadar; the server
 * never asks Amazon.
 */
export function bookmarkletCode(origin: string): string {
  const source = `(()=>{var D=${JSON.stringify(origin)};if(!/(^|\\.)amazon\\.fr$/.test(location.hostname)){alert("Ouvrez d'abord une fiche produit Amazon.fr.");return}var w=window.open(D+"/lire","dealradar-lire");if(!w){alert("Autorisez les fenêtres de DealRadar sur amazon.fr.");return}var h=document.documentElement.outerHTML,u=location.href;function f(e){if(e.origin!==D||e.source!==w||!e.data||e.data.type!=="dealradar-ready")return;removeEventListener("message",f);w.postMessage({type:"dealradar-page",url:u,html:h},D)}addEventListener("message",f)})();`;
  return `javascript:${encodeURIComponent(source)}`;
}

/**
 * « Lire dans DealRadar » (epic 33): the button to drag into the bookmarks
 * bar, for links Amazon blocks from the server. React refuses `javascript:`
 * hrefs, so the link is set on the element after mount.
 */
const ReadButtonInstall: FC = () => {
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    anchor.current?.setAttribute(
      "href",
      bookmarkletCode(window.location.origin),
    );
  }, []);

  return (
    <Paper withBorder p="md" radius="md">
      <Stack gap={6}>
        <Group gap="sm" wrap="wrap">
          <Text fw={600}>Lien bloqué par Amazon ?</Text>
          <Anchor
            ref={anchor}
            href="#"
            onClick={(event) => {
              event.preventDefault();
            }}
            fw={600}
            c="var(--mantine-color-text)"
            px="sm"
            py={4}
            style={{
              border: "1px solid var(--mantine-color-default-border)",
              borderRadius: 6,
              cursor: "grab",
            }}
            aria-label="Lire dans DealRadar (à glisser dans la barre de favoris)"
          >
            <Group gap={6} wrap="nowrap">
              <Icon name="link" size={14} />
              Lire dans DealRadar
            </Group>
          </Anchor>
        </Group>
        <Text fz="sm" c="dimmed">
          Glissez ce bouton dans votre barre de favoris (ordinateur). Quand un
          lien finit sur « vérification anti-robot d'Amazon », ouvrez la fiche
          produit dans votre navigateur, connecté à DealRadar, puis cliquez sur
          le bouton : DealRadar lit la page que vous voyez, avec les mêmes
          contrôles qu'une lecture du serveur. Le serveur ne contacte pas
          Amazon.
        </Text>
      </Stack>
    </Paper>
  );
};

export default ReadButtonInstall;
