#!/usr/bin/env bash
# One-time setup of the gateway + live stand on a Debian/Ubuntu server (systemd not required).
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<repo>/<ref>/stand/install.sh | REF=<ref> bash
set -euo pipefail
REPO=${REPO:-https://github.com/raulwulff6769/framework-lab.git}
DIR=${DIR:-/opt/itles}
if ! command -v git >/dev/null || ! command -v python3 >/dev/null; then
  apt-get update -y && apt-get install -y --no-install-recommends git python3 ca-certificates
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else "нужен Python 3.10+")'
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch --depth 1 origin "${REF:-HEAD}" && git -C "$DIR" checkout -f FETCH_HEAD
else
  git clone --depth 1 ${REF:+-b "$REF"} "$REPO" "$DIR"
fi
ENV="$DIR/stand/stand.env"
if [ ! -f "$ENV" ]; then
  install -m 600 "$DIR/stand/stand.env.example" "$ENV"
  [ -n "${STAND_KEY:-}" ] && sed -i "s|^STAND_KEY=.*|STAND_KEY=$STAND_KEY|" "$ENV"
fi
if ! grep -q '^STAND_KEY=.\+' "$ENV"; then
  echo "Впишите ключ шлюза в $ENV (STAND_KEY=...) и запустите снова"; exit 1
fi
pkill -f "$DIR/stand/run.sh" 2>/dev/null || true
nohup "$DIR/stand/run.sh" > "$DIR/stand/nohup.log" 2>&1 &
if command -v crontab >/dev/null; then
  (crontab -l 2>/dev/null | grep -v "stand/run.sh"; echo "@reboot $DIR/stand/run.sh > $DIR/stand/nohup.log 2>&1") | crontab -
fi
echo "Готово: шлюз слушает 5034/5037/5039/5041/5090, стенд отчитывается в ITles. Логи: $DIR/.stand/"
