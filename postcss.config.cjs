/*
 * Mantine ships its component styles with `rem()` calls, `light-dark()`
 * helpers and `@mixin` breakpoints that only exist after this preset runs —
 * without it the components render unstyled-ish and media queries never
 * match.
 *
 * `.cjs` because the package is `"type": "module"`: PostCSS would otherwise
 * try to read this as ESM and fail on `module.exports`.
 */
module.exports = {
  plugins: {
    "postcss-preset-mantine": {},
    "postcss-simple-vars": {
      variables: {
        "mantine-breakpoint-xs": "36em",
        "mantine-breakpoint-sm": "48em",
        "mantine-breakpoint-md": "62em",
        "mantine-breakpoint-lg": "75em",
        "mantine-breakpoint-xl": "88em",
      },
    },
  },
};
