import { createTheme, type MantineColorsTuple } from "@mantine/core";

/**
 * DealRadar's visual identity.
 *
 * One rule drives every choice here: the accent colour carries *price
 * information* and nothing else. A lime chip on a card always means "this is
 * what you save". It is never used for decoration, headings or chrome, so a
 * user scanning a grid can rely on it the way they rely on a price tag.
 *
 * Everything else is deliberately neutral — a deal grid is already a riot of
 * product photography, and a colourful interface would compete with it.
 */

/** The signal accent. Shades are hand-tuned; Mantine's generator washes lime out. */
const signal: MantineColorsTuple = [
  "#f5fde4",
  "#eaf7cd",
  "#d4ee9d",
  "#bde569",
  "#aadd3f",
  "#9ed824",
  "#97d615",
  "#83bd07",
  "#73a800",
  "#619000",
];

/**
 * A cooler, slightly bluer grey than Mantine's default `dark`, so product
 * photography (usually warm) separates from the background.
 *
 * The indices are not arbitrary — Mantine maps them to semantic variables:
 * 0 → text, 2 → dimmed text, 3 → placeholder, 4 → borders,
 * 5 → hover, 6 → input/button surfaces, 7 → page body.
 */
const dark: MantineColorsTuple = [
  "#e9eef6",
  "#c5cedd",
  "#8e9bb0",
  "#6c7a8f",
  "#333e4d",
  "#222b38",
  "#1a222d",
  "#11151c",
  "#0c0f14",
  "#07090c",
];

export const theme = createTheme({
  primaryColor: "signal",
  primaryShade: { light: 8, dark: 4 },
  colors: { signal, dark },
  // Lime is bright: on a filled button it needs dark text, on a dark badge it
  // needs light text. Letting Mantine pick per-surface avoids unreadable pairs.
  autoContrast: true,
  luminanceThreshold: 0.4,
  defaultRadius: "md",
  fontFamily:
    'InterVariable, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  headings: {
    fontFamily:
      'InterVariable, Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    sizes: {
      h1: { fontSize: "2rem", lineHeight: "1.2", fontWeight: "700" },
      h2: { fontSize: "1.5rem", lineHeight: "1.25", fontWeight: "650" },
      h3: { fontSize: "1.125rem", lineHeight: "1.3", fontWeight: "600" },
      h4: { fontSize: "1rem", lineHeight: "1.35", fontWeight: "600" },
    },
  },
  components: {
    Card: {
      defaultProps: { withBorder: true, radius: "lg" },
    },
    Paper: {
      defaultProps: { withBorder: true, radius: "lg" },
    },
    Badge: {
      defaultProps: { radius: "sm", tt: "none", fw: 600 },
    },
    Button: {
      defaultProps: { radius: "md" },
    },
    Anchor: {
      defaultProps: { underline: "never" },
    },
  },
  other: {
    /** Cards must not be the same colour as the page, or the grid reads flat. */
    surface: "var(--app-surface)",
    surfaceMuted: "var(--app-surface-muted)",
  },
});
