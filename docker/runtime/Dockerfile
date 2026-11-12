# Runtime image for DealRadar on the container-based Bay (DEPLOY.md, « Image
# d'exécution »). Bay runs an archive app in `node:<major>-slim` and installs
# nothing: no `playwright` module (the build's only external dependency, see
# dist/package.json) and no Chromium or its system libraries. This image is
# that same base plus exactly those, so the browser sources, auto-publish and
# the Dealabs « écran distant » work:
#
#   - `playwright` in /opt/playwright, linked as /node_modules: Node resolves it from /app/server/… by
#     walking up the tree, so the app needs no NODE_PATH.
#   - Chromium + headless shell at /ms-playwright with their system libraries
#     (`--with-deps`). DEALRADAR_BROWSERS_PREINSTALLED=1 tells the app to
#     only check them: Bay's read-only root filesystem makes Playwright's own
#     installer hang on its lock file, and launches wait for it.
#   - Xvfb on DISPLAY=:99 for the visible Dealabs browser, started by the
#     entrypoint before the app.
#
# Keep NODE_MAJOR equal to the build's runtime (manifest.json →
# runtimeVersion) and PLAYWRIGHT_VERSION equal to package.json's pin.
ARG NODE_MAJOR=22
FROM node:${NODE_MAJOR}-bookworm-slim

ARG PLAYWRIGHT_VERSION=1.63.0
ARG PLAYWRIGHT_EXTRA_VERSION=4.3.6
ARG STEALTH_PLUGIN_VERSION=2.11.2
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    DEALRADAR_BROWSERS_PATH=/ms-playwright \
    DEALRADAR_BROWSERS_PREINSTALLED=1 \
    DISPLAY=:99

RUN set -eux; \
    mkdir -p /opt/playwright && cd /opt/playwright; \
    echo '{"private":true}' > package.json; \
    npm install --no-audit --no-fund --omit=dev \
      "playwright@${PLAYWRIGHT_VERSION}" "playwright-core@${PLAYWRIGHT_VERSION}" \
      "playwright-extra@${PLAYWRIGHT_EXTRA_VERSION}" \
      "puppeteer-extra-plugin-stealth@${STEALTH_PLUGIN_VERSION}"; \
    ln -s /opt/playwright/node_modules /node_modules; \
    node /node_modules/playwright/cli.js install --with-deps chromium chromium-headless-shell; \
    apt-get update; \
    apt-get install -y --no-install-recommends xvfb xauth fonts-liberation fonts-noto-color-emoji tini; \
    rm -rf /var/lib/apt/lists/* /root/.npm; \
    chmod -R a+rwX /ms-playwright; \
    mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

COPY entrypoint.sh /usr/local/bin/dealradar-entrypoint
RUN chmod 0755 /usr/local/bin/dealradar-entrypoint

# -s: Bay runs the container with its own init as PID 1, so tini must
# register as subreaper to reap the Chromium processes it inherits.
ENTRYPOINT ["/usr/bin/tini", "-s", "--", "/usr/local/bin/dealradar-entrypoint"]
CMD ["node"]
