import type { FC, SVGProps } from "react";

/**
 * Inline icon set.
 *
 * Hand-kept rather than pulled from an icon package: the console needs ~20
 * glyphs, and inlining them keeps the SSR output self-contained (no icon
 * font, no extra request, no flash of un-iconed UI) for a fraction of a
 * kilobyte each. All glyphs share a 24×24 box and `currentColor` strokes so
 * they inherit text colour and size from their container.
 */
const PATHS = {
  dashboard: "M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z",
  tag: "M3 3h7l11 11-7 7L3 10z|M7.5 7.5h.01",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z|M21 21l-4.3-4.3",
  filter: "M22 3H2l8 9.5V19l4 2v-8.5z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z|M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  external:
    "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6|M15 3h6v6|M10 14L21 3",
  chevronRight: "M9 18l6-6-6-6",
  chevronLeft: "M15 18l-6-6 6-6",
  chevronDown: "M6 9l6 6 6-6",
  close: "M18 6L6 18M6 6l12 12",
  check: "M20 6L9 17l-5-5",
  alert:
    "M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z|M12 9v4M12 17h.01",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2",
  trendingDown: "M23 18l-9.5-9.5-5 5L1 6|M17 18h6v-6",
  trendingUp: "M23 6l-9.5 9.5-5-5L1 18|M17 6h6v6",
  image:
    "M3 3h18v18H3z|M8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z|M21 15l-5-5L5 21",
  refresh:
    "M23 4v6h-6|M1 20v-6h6|M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15",
  flame:
    "M12 22c4 0 7-2.7 7-6.5 0-4-3-6-4.5-9.5-1 2-2 2.5-3 3.5-1-1-1.5-2-1.5-3.5C7 8 5 11 5 15.5 5 19.3 8 22 12 22z",
  bolt: "M13 2L3 14h8l-1 8 10-12h-8z",
  store:
    "M3 9l1.5-6h15L21 9|M3 9h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z|M8 21v-7h8v7",
  package: "M21 16V8l-9-5-9 5v8l9 5z|M3.3 7.5L12 12.5l8.7-5M12 22V12.5",
  menu: "M3 6h18M3 12h18M3 18h18",
  sortDesc: "M3 6h12M3 12h8M3 18h4|M18 8v10M22 14l-4 4-4-4",
  eye: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z|M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  inbox:
    "M22 12h-6l-2 3h-4l-2-3H2|M5.5 5h13l3.5 7v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-6z",
  play: "M5 3l16 9-16 9z",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4|M16 17l5-5-5-5|M21 12H9",
  copy: "M9 9h11a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1z|M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
} as const;

export type IconName = keyof typeof PATHS;

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  /** Edge length in pixels; the icon is always square. */
  size?: number;
}

/**
 * Icons are decorative by default (`aria-hidden`) because they virtually
 * always sit next to a text label. Pass an `aria-label` to opt into being
 * announced, which also flips the element to `role="img"`.
 */
export const Icon: FC<IconProps> = ({
  name,
  size = 20,
  className,
  ...rest
}) => {
  const labelled = rest["aria-label"] !== undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={labelled ? undefined : true}
      role={labelled ? "img" : undefined}
      {...rest}
    >
      {PATHS[name].split("|").map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
};

export default Icon;
