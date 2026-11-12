#!/bin/sh
# Starts the virtual display the visible Dealabs browser draws on, then runs
# whatever Bay asked for (the app's `node …`). A display that fails to start
# never stops the app: headless sources still work without it.
set -e

if [ -n "${DISPLAY:-}" ] && command -v Xvfb >/dev/null 2>&1; then
  n="${DISPLAY#:}"
  n="${n%%.*}"
  if [ ! -e "/tmp/.X11-unix/X${n}" ]; then
    Xvfb "${DISPLAY}" -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  fi
fi

exec "$@"
