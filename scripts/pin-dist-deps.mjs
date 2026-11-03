#!/usr/bin/env node
/**
 * `alepha build` writes the server's external dependencies to
 * `dist/package.json` as caret ranges (`^1.63.0`), and the VM installs
 * from that file: a deploy could pick up a newer Playwright than the one
 * tested, which needs another Chromium build (2026-11, epic 23). This
 * rewrites each one to the exact version installed here.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export function pinDependencies(deps, versionOf) {
  return Object.fromEntries(
    Object.entries(deps).map(([name, range]) => [
      name,
      versionOf(name) ?? range,
    ]),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const root = resolve(import.meta.dirname, "..");
  const file = join(root, "dist", "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const require = createRequire(join(root, "package.json"));
  pkg.dependencies = pinDependencies(pkg.dependencies ?? {}, (name) => {
    try {
      return JSON.parse(
        readFileSync(require.resolve(`${name}/package.json`), "utf8"),
      ).version;
    } catch {
      return undefined;
    }
  });
  writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`dist/package.json pinned: ${JSON.stringify(pkg.dependencies)}`);
}
