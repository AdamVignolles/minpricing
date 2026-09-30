import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tailwindcss()],
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
    external: ["playwright", "playwright-core", "@cloudflare/puppeteer"],
  },
  test: {
    root: ".",
    globals: true,
  },
});
