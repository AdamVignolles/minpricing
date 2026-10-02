import { Box, Text } from "@mantine/core";
import { type FC, useState } from "react";

import Icon from "../ui/Icon.tsx";

export interface DealImageProps {
  src?: string;
  alt: string;
  /** Aspect ratio as width / height. Cards use 4:3, the detail page 1:1. */
  ratio?: number;
  /** `eager` for the handful of images above the fold, `lazy` everywhere else. */
  loading?: "lazy" | "eager";
  fallbackLabel?: string;
  radius?: string;
}

/**
 * Product image with a reserved box and a graceful failure mode.
 *
 * Two problems are solved here that a bare `<img>` does not solve:
 *
 * 1. **Layout stability.** The aspect ratio is reserved before the bytes
 *    arrive, so a grid of cards never reflows as images stream in.
 * 2. **Dead hotlinks.** Every URL points at a merchant's CDN we do not
 *    control; they expire, rate-limit and occasionally serve a 403. Rather
 *    than show a broken-image glyph, we fall back to a neutral placeholder
 *    that keeps the card's shape intact.
 *
 * Images are *not* proxied. Merchant CDNs are built for hotlinking, serve
 * correctly-sized derivatives already, and re-hosting their product shots
 * would raise a rights question the app has no need to raise.
 */
const DealImage: FC<DealImageProps> = ({
  src,
  alt,
  ratio = 4 / 3,
  loading = "lazy",
  fallbackLabel,
  radius = "var(--mantine-radius-md)",
}) => {
  const [failed, setFailed] = useState(false);
  const showFallback = !src || failed;

  return (
    <Box
      style={{
        position: "relative",
        aspectRatio: String(ratio),
        overflow: "hidden",
        borderRadius: radius,
        background: "var(--app-surface-muted)",
      }}
    >
      {showFallback ? (
        <Box
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 6,
          }}
          // The fallback is decorative: the alt text is already carried by the
          // card's title link, so announcing it twice only adds noise.
          aria-hidden
        >
          <Icon name="image" size={22} color="var(--mantine-color-dimmed)" />
          {fallbackLabel ? (
            <Text fz="xs" c="dimmed" ta="center" px="xs" lineClamp={1}>
              {fallbackLabel}
            </Text>
          ) : null}
        </Box>
      ) : (
        <img
          src={src}
          alt={alt}
          loading={loading}
          decoding="async"
          onError={() => setFailed(true)}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // `contain` rather than `cover`: these are packshots on white, and
            // cropping them cuts the product itself rather than a background.
            objectFit: "contain",
            display: "block",
          }}
        />
      )}
    </Box>
  );
};

export default DealImage;
