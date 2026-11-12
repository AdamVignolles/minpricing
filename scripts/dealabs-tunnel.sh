#!/usr/bin/env bash
# Lets the VPS's Dealabs browser go out through THIS machine's connection
# (a residential address Dealabs doesn't block), at no cost:
#
#   bash scripts/dealabs-tunnel.sh          # keep it running while publishing
#
# `ssh -R 1080` (no destination) makes the VPS's 127.0.0.1:1080 a SOCKS5
# proxy whose traffic leaves from here. A systemd relay on the VPS
# (dealabs-socks-relay) exposes it to the app's container at
# 172.17.0.1:1080, which is DEALABS_PROXY_URL=socks5://172.17.0.1:1080.
# Only the Dealabs window uses it; collectors keep the VPS connection.
# Tunnel down = Dealabs window can't load (publishing waits); stop it
# and unset DEALABS_PROXY_URL to go back to the direct connection.
set -euo pipefail
HOST="${DEALRADAR_VPS_HOST:-ovh-adam}"
while true; do
  ssh -N -R 127.0.0.1:1080 \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
    "$HOST" || true
  echo "tunnel closed, retrying in 5 s" >&2
  sleep 5
done
