import { defineConfig } from "vitest/config";

export default defineConfig({
  // Styling is Mantine + PostCSS (see postcss.config.cjs), which Vite picks
  // up on its own — no style plugin to register here.
  server: {
    watch: {
      ignored: ["**/data/**"],
    },
  },
  // `playwright` (used by the Amazon/Cdiscount collectors) ships native
  // Node bindings and dynamic requires that can't be bundled for SSR — it
  // must stay a real `require`/`import` at runtime instead of being
  // inlined into the server bundle.
  ssr: {
    external: ["playwright", "playwright-core"],
  },
  test: {
    root: ".",
    globals: true,
  },
});
