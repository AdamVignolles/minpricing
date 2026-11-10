#!/usr/bin/env bash
# One-time setup of Bay on the OVH VPS (DEPLOY.md, « VPS OVH »).
# Run from the project, on the deploying machine:
#
#   ssh minpricing-ovh 'bash -s' -- <you@example.com> < scripts/setup-ovh-vps.sh
#
# Installs Bay (and Docker), writes its systemd unit with <public IP>.sslip.io
# as base domain, starts it, lets the SSH user deploy (group bay-control) and
# opens ports 22/80/443 when ufw is active. Safe to run again.
set -euo pipefail

EMAIL="${1:?usage: setup-ovh-vps.sh <e-mail for Let's Encrypt>}"
DEPLOY_USER="$(id -un)"
IP="$(curl -4 -fsS https://ifconfig.me || hostname -I | awk '{print $1}')"
[ -n "$IP" ] || { echo "Could not find the public IPv4" >&2; exit 1; }

echo "==> Installing Bay (and Docker if missing)"
curl -sSL https://alepha.dev/bay/install.sh | sudo sh

echo "==> Writing /etc/systemd/system/bay.service (base domain $IP.sslip.io)"
sudo tee /etc/systemd/system/bay.service >/dev/null <<UNIT
[Unit]
Description=Bay - Alepha application server
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
Restart=always
RestartSec=2
WorkingDirectory=/opt/bay
RuntimeDirectory=bay
RuntimeDirectoryMode=0755
ExecStart=/opt/bay/bin/bay serve \\
  --root /opt/bay/data \\
  --base-domain $IP.sslip.io \\
  --addr :80 \\
  --tls --tls-addr :443 \\
  --acme-email $EMAIL \\
  --control-socket /run/bay/control.sock

[Install]
WantedBy=multi-user.target
UNIT

if command -v ufw >/dev/null && sudo ufw status | grep -q "Status: active"; then
  echo "==> Opening ports 22, 80, 443 in ufw"
  sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443
fi

echo "==> Starting Bay"
sudo systemctl daemon-reload
sudo systemctl enable bay
sudo systemctl restart bay
for _ in $(seq 1 15); do [ -S /run/bay/control.sock ] && break; sleep 1; done

echo "==> Allowing $DEPLOY_USER to deploy (group bay-control)"
getent group bay-control >/dev/null || sudo groupadd --system bay-control
sudo usermod -aG bay-control "$DEPLOY_USER"

echo "==> Checks"
sudo bay doctor || true
sudo bay status

echo
echo "Done. The app will be served at https://minpricing-ovh.$IP.sslip.io"
echo "Next, on your machine: npx alepha platform login --env ovh && npm run deploy:ovh"
