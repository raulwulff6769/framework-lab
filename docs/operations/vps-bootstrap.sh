#!/usr/bin/env bash
# ITles / «Отсчёт» — VPS bootstrap, PHASE A: serve the site FROM the VPS via Cloudflare Tunnel.
#
# Run this ON the VPS (you are SSH'd in as agentuser, sudo available). It is OUTBOUND-ONLY —
# it needs NO inbound ports open, so it works even while the Tencent Security Group blocks
# 22/80/443. That is the whole point: we do not touch the Tencent console at all.
#
# NOTE: UNVERIFIED against your live box — Zo cannot reach it inbound. Run it stage by stage
# and paste the output back so we confirm each step.
#
# Set these before running (the script refuses to start without them):
#   export DATABASE_URL='postgresql://USER:PASS@ep-calm-hall-awak5tvl.../neondb?sslmode=require'
#   export SETUP_KEY='<admin-setup-key>'
#   # For a faithful prod replica on the shared Neon DB, ALSO export these (same values as Vercel prod):
#   export GATEWAY_TOKEN='<prod value>'   # REQUIRED for the stand/gateway -> API data pipeline
#   export APP_SECRET='<prod value>'      # session/token signing (keep same as prod)
#   export CRON_SECRET='<prod value>'     # optional on VPS, set for parity
#   # optional: export APP_DIR="$HOME/itles"  PORT=8787
set -euo pipefail

APP_DIR="${APP_DIR:-$HOME/itles}"
PORT="${PORT:-8787}"
REPO='https://github.com/raulwulff6769/framework-lab.git'
BRANCH='otschet-current'

say(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$1"; }
need_env(){ eval "v=\${$1:-}"; [ -n "$v" ] || { echo "!! set \$$1 before running (see header)"; exit 1; }; }

need_env DATABASE_URL
need_env SETUP_KEY

say "0) sanity"
echo "user=$(whoami) arch=$(uname -m) app_dir=$APP_DIR port=$PORT"
command -v sudo >/dev/null || { echo "!! sudo required"; exit 1; }

say "1) Node 20 + pnpm + git (idempotent)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo corepack enable 2>/dev/null || sudo npm i -g pnpm
corepack prepare pnpm@latest --activate 2>/dev/null || true
command -v git >/dev/null || sudo apt-get install -y git
echo "node=$(node -v) pnpm=$(pnpm -v) git=$(git --version)"

say "2) clone/update repo @ $BRANCH"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH"
  git -C "$APP_DIR" checkout -B "$BRANCH" "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$APP_DIR"
fi
git -C "$APP_DIR" log --oneline -1
say "3) build SPA"
pnpm --dir "$APP_DIR/platform" install --frozen-lockfile --prod=false
pnpm --dir "$APP_DIR/platform" build
test -f "$APP_DIR/platform/dist/index.html" && echo "dist OK" || { echo "!! build produced no dist"; exit 1; }

say "4) systemd service on 127.0.0.1:$PORT (DB = your Neon — Phase A, zero data migration)"
# Write only the vars that are set. DATABASE_URL + SETUP_KEY are required (checked above);
# GATEWAY_TOKEN/APP_SECRET/CRON_SECRET are written when exported, so the VPS matches prod.
{
  echo "PORT=$PORT"
  echo "STATIC_DIR=dist"
  echo "NODE_ENV=production"
  echo "DATABASE_URL=$DATABASE_URL"
  echo "SETUP_KEY=$SETUP_KEY"
  [ -n "${GATEWAY_TOKEN:-}" ] && echo "GATEWAY_TOKEN=$GATEWAY_TOKEN"
  [ -n "${APP_SECRET:-}" ]    && echo "APP_SECRET=$APP_SECRET"
  [ -n "${CRON_SECRET:-}" ]   && echo "CRON_SECRET=$CRON_SECRET"
} | sudo tee /etc/itles.env >/dev/null
sudo chmod 600 /etc/itles.env
TSX="$APP_DIR/platform/node_modules/.bin/tsx"
sudo tee /etc/systemd/system/itles.service >/dev/null <<EOF
[Unit]
Description=ITles Otschet server
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$APP_DIR/platform
EnvironmentFile=/etc/itles.env
ExecStart=$TSX dev/server.ts
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now itles
sleep 2
curl -fsS "http://127.0.0.1:$PORT/" >/dev/null && echo "UI OK on 127.0.0.1:$PORT" \
  || echo "!! UI check failed — inspect: journalctl -u itles -n 60 --no-pager"
sudo systemctl --no-pager status itles | head -5

say "5) cloudflared — expose on your domain with NO inbound ports"
if ! command -v cloudflared >/dev/null; then
  ARCH=amd64; [ "$(uname -m)" = aarch64 ] && ARCH=arm64
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-$ARCH" -o /tmp/cloudflared
  sudo install -m755 /tmp/cloudflared /usr/local/bin/cloudflared
fi
echo "cloudflared=$(cloudflared --version 2>&1 | head -1)"
cat <<'NEXT'

>>> FINISH THE TUNNEL — interactive, one time (opens a browser URL to log into YOUR Cloudflare):
      cloudflared tunnel login
      cloudflared tunnel create itles
      cloudflared tunnel route dns itles  ВАШ.ДОМЕН     # cloudflared creates the proxied DNS itself
    Then write ~/.cloudflared/config.yml:
      tunnel: itles
      credentials-file: /home/agentuser/.cloudflared/<UUID>.json
      ingress:
        - hostname: ВАШ.ДОМЕН
          service: http://127.0.0.1:8787
        - service: http_status:404
    Install it to run on boot:
      sudo cloudflared service install
<<< Open https://ВАШ.ДОМЕН — it now serves from THIS VPS, works in RU without VPN.
    All writes still land in your Neon DB (it stays the database in Phase A — nothing to mirror yet).
NEXT
echo; echo "DONE (Phase A). Redeploy after a code change:  git -C $APP_DIR pull && pnpm --dir $APP_DIR/platform build && sudo systemctl restart itles"
