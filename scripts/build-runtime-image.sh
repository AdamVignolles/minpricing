#!/usr/bin/env bash
# Builds DealRadar's runtime image (docker/runtime), checks that Chromium
# starts in it, pushes it to ghcr.io and prints the `bay runtimes set` line
# with the pushed digest. Run on a machine with Docker (the VPS has it), from
# the project root:
#
#   echo <token> | docker login ghcr.io -u <github user> --password-stdin
#   bash scripts/build-runtime-image.sh <github user>
#
# The token needs `write:packages`. Make the package public once on GitHub
# (Packages → dealradar-runtime → Package settings → Change visibility):
# Bay pulls without registry credentials.
set -euo pipefail

OWNER="${1:?usage: build-runtime-image.sh <github user or org>}"
OWNER="$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')"
PW="$(node -p 'require("./package.json").dependencies.playwright.replace(/^[^0-9]*/, "")')"
TAG="ghcr.io/${OWNER}/dealradar-runtime:node22-pw${PW}"

echo "==> Building ${TAG}"
docker build --build-arg "PLAYWRIGHT_VERSION=${PW}" -t "${TAG}" docker/runtime

echo "==> Checking Chromium (headless and on the virtual display) as a non-root user"
docker run --rm --user 20000:20000 -e HOME=/tmp "${TAG}" node -e '
  const { chromium } = require("playwright");
  (async () => {
    for (const headless of [true, false]) {
      const b = await chromium.launch({ headless });
      const p = await b.newPage();
      await p.setContent("<title>ok</title>");
      console.log(headless ? "headless" : "visible", await p.title());
      await b.close();
    }
  })().catch((e) => { console.error(e); process.exit(1); });
'

echo "==> Pushing"
docker push "${TAG}"
DIGEST="$(docker inspect --format '{{index .RepoDigests 0}}' "${TAG}")"

echo
echo "Pushed: ${DIGEST}"
echo "On the VPS:"
echo "  sudo bay runtimes set minpricing/production ${DIGEST}"
echo "  sudo bay harden minpricing/production --memory 1g   # restarts the app on the new image"
