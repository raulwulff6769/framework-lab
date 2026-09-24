#!/usr/bin/env bash
# Starts the ITles gateway and the live stand on one host and restarts either if it exits.
# Works without systemd (containers, Zo/gVisor VPS). Configuration: stand/stand.env, see stand.env.example.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENV_FILE=${STAND_ENV:-$ROOT/stand/stand.env}
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
: "${ITLES_API_URL:?задайте ITLES_API_URL в stand/stand.env}"
: "${STAND_KEY:?задайте STAND_KEY (ключ шлюза из «Настройки → Ключи шлюзов»)}"
DATA=${STAND_DATA:-$ROOT/.stand}
mkdir -p "$DATA" && chmod 700 "$DATA"
PY=${PYTHON:-python3}
[ -x "$ROOT/.venv/bin/python" ] && [ -z "${PYTHON:-}" ] && PY="$ROOT/.venv/bin/python"

cd "$ROOT"
"$PY" -m stand --write-mappings "$DATA/mappings.json"
export GATEWAY_TOKEN="$STAND_KEY" QUEUE_PATH="$DATA/gateway-queue.sqlite3" MAPPINGS_FILE="$DATA/mappings.json"
export STATUS_FILE="$DATA/gateway-status.json" GATEWAY_STATUS_FILE="$DATA/gateway-status.json" STAND_STATE="$DATA/stand-state.json"
export PORT_NAVTELECOM_FLEX=${PORT_NAVTELECOM_FLEX:-5041}

supervise() {
  local name=$1 dir=$2; shift 2
  while true; do
    # keep logs bounded on a small disk
    if [ -f "$DATA/$name.log" ] && [ "$(stat -c %s "$DATA/$name.log")" -gt 20000000 ]; then mv -f "$DATA/$name.log" "$DATA/$name.log.1"; fi
    echo "$(date -u +%FT%TZ) start $name" >> "$DATA/$name.log"
    (cd "$dir" && "$@") >> "$DATA/$name.log" 2>&1 || true
    echo "$(date -u +%FT%TZ) $name exited, restart in 5 s" >> "$DATA/$name.log"
    sleep 5
  done
}

LOG_LEVEL=${GATEWAY_LOG_LEVEL:-WARNING} supervise gateway "$ROOT/gateway" "$PY" -m itles_gateway &
GW=$!
sleep 2
supervise stand "$ROOT" "$PY" -m stand &
ST=$!
echo "$GW $ST" > "$DATA/run.pids"
trap 'pkill -P $GW 2>/dev/null; pkill -P $ST 2>/dev/null; kill $GW $ST 2>/dev/null; exit 0' INT TERM
echo "стенд запущен: логи в $DATA/{gateway,stand}.log, остановить: kill $$"
wait
