# DealRadar's runtime image on Bay.
#
# Bay runs an app's release (mounted read-only at /app) as `node index.node.js`
# in node:26-slim. DealRadar also drives Chromium through Playwright, which the
# release does not bundle (`ssr.external` in vite.config.ts), so this image adds:
#   - Chromium's system libraries and fonts;
#   - /node_modules/playwright (a link to /opt/playwright), found by Node
#     walking up from /app;
#   - the browsers, at /ms-playwright.
# The headed browser (Dealabs login, publishing) draws on the host's Xvfb `:99`,
# whose socket Bay hands over with `bay harden --mount /tmp/.X11-unix`.
#
# Keep PLAYWRIGHT_VERSION equal to the version in package-lock.json.
# Build and select it on the VM (see DEPLOY.md):
#   docker build -t dealradar-runtime:pw-1.63.0 deploy/runtime
#   bay runtimes set minpricing/production dealradar-runtime:pw-1.63.0
FROM node:26-slim@sha256:36793bcbb160a6a16cede1e62b93f84e26b78a972a8a4c0b879c1c12f22761ec

ARG PLAYWRIGHT_VERSION=1.63.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN mkdir -p /opt/playwright && cd /opt/playwright \
  && npm install --no-save --no-package-lock --omit=dev "playwright@${PLAYWRIGHT_VERSION}" \
  && ln -s /opt/playwright/node_modules /node_modules \
  && /node_modules/.bin/playwright install --with-deps chromium chromium-headless-shell \
  && chmod -R a+rX /ms-playwright /opt/playwright \
  && npm cache clean --force \
  && rm -rf /var/lib/apt/lists/* /root/.cache /tmp/*
