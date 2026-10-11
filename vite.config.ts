import { defineConfig } from "vitest/config";

export default defineConfig({
  // Styling is Mantine + PostCSS (see postcss.config.cjs), which Vite picks
  // up on its own — no style plugin to register here.
  server: {
    watch: {
      // Only app code should trigger a dev-server reload. On Windows,
      // Alepha's reloader fails ("Alepha instance not found after loading
      // entry module") whenever the changed file isn't imported by the app:
      // it never re-runs the server entry in that case (it looks the entry
      // up with a backslash path that never matches Vite's module ids). So
      // everything that isn't app code stays unwatched: runtime writes (the
      // SQLite database, the Dealabs publisher's session and failure
      // snapshots) and project files (docs, tests, migrations, scripts).
      ignored: [
        "**/data/**",
        "**/.dealabs-debug/**",
        "**/.dealabs-session.json",
        "**/*.md",
        "**/test/**",
        "**/migrations/**",
        "**/docs/**",
        "**/scripts/**",
        "**/dist/**",
      ],
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
