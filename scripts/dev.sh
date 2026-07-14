#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# ── color helpers ─────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

# ── load .env ──────────────────────────────────────────────
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

PIPLUS_LOG_DIR="${PIPLUS_LOG_DIR:-/tmp/piplus-logs}"
mkdir -p "$PIPLUS_LOG_DIR"

API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-3003}"
WEB_PORT="${WEB_PORT:-3004}"
PUBLIC_ORIGIN="${PUBLIC_WEB_ORIGIN:-}"
WEB_DIST="${PIPLUS_WEB_DIST:-$PWD/apps/web/dist}"

# ── detect if we're in production mode ────────────────────
if [ -n "$PUBLIC_ORIGIN" ]; then
  MODE="production"
else
  MODE="development"
fi

# ── LAN address (dev mode only) ───────────────────────────
detect_lan_ip() {
  local ip=""
  for iface in eth0 en0 wlan0 ens33 enp0s3; do
    ip=$(ip -4 addr show "$iface" 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1)
    [ -n "$ip" ] && { echo "$ip"; return; }
  done
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip" ] && { echo "$ip"; return; }
  echo "127.0.0.1"
}
LAN_IP=$(detect_lan_ip)

# ── banner ─────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║              piplus                      ║"
printf "  ║  mode · %-28s  ║\n" "$MODE"
echo "  ╠══════════════════════════════════════════╣"
printf "  ║  API  · http://localhost:%-5s           ║\n" "$API_PORT"

if [ "$MODE" = "development" ]; then
  printf "  ║  Web  · https://localhost:%-5s          ║\n" "$WEB_PORT"
  echo "  ╠══════════════════════════════════════════╣"
  printf "  ║  LAN  · https://%s:%-5s          ║\n" "$LAN_IP" "$WEB_PORT"
fi
if [ "$MODE" = "production" ]; then
  echo "  ╠══════════════════════════════════════════╣"
  printf "  ║  URL  · %-36s  ║\n" "$PUBLIC_ORIGIN"
fi
echo "  ╚══════════════════════════════════════════╝"
echo ""

if [ -z "${APP_PASSWORD:-}" ]; then
  echo -e "  ${CYAN}⚠${NC}  APP_PASSWORD not set, using default: piplus-local"
fi

echo ""
echo "[piplus] logs → ${PIPLUS_LOG_DIR}"

# ── clean stale cache ─────────────────────────────────────
rm -rf apps/web/.next

# ── build web (production mode) ───────────────────────────
PIDS=""

if [ "$MODE" = "production" ]; then
  if [ ! -f "$WEB_DIST/index.html" ]; then
    echo -e "  ${CYAN}📦 Building web frontend ...${NC}"
    cd apps/web
    bun run build
    cd "$OLDPWD"
    echo -e "  ${GREEN}  ✅ Web built${NC}"
  else
    echo -e "  ${GREEN}  ✅ Web dist found${NC}"
  fi
fi

# ── export env for API ────────────────────────────────────
export API_HOST
export API_PORT
if [ "$MODE" = "production" ]; then
  export PIPLUS_SERVE_WEB=1
  export PIPLUS_WEB_DIST="$WEB_DIST"
  export PUBLIC_WEB_ORIGIN="$PUBLIC_ORIGIN"
fi

# ── launch API ────────────────────────────────────────────
echo "[piplus] starting API on port ${API_PORT} ..."
if [ "$MODE" = "production" ]; then
  DISPLAY=:1 bun run apps/api/src/index.ts 2>&1
else
  bun run apps/api/src/index.ts > >(sed 's/^/[api] /' | tee -a "$PIPLUS_LOG_DIR/api.log") 2>&1 &
  API_PID=$!
  PIDS="$API_PID"
fi

# ── launch Vite dev (dev mode only) ───────────────────────
if [ "$MODE" = "development" ]; then
  sleep 1
  echo "[piplus] starting Web on port ${WEB_PORT} ..."
  cd apps/web && npx vite --host 0.0.0.0 --port "${WEB_PORT}" > >(sed 's/^/[web] /' | tee -a "$PIPLUS_LOG_DIR/web.log") 2>&1 &
  WEB_PID=$!
  PIDS="$PIDS $WEB_PID"
fi

# trap 'echo; echo "[piplus] shutting down..."; kill -9 '$PIDS' 2>/dev/null; exit' INT TERM

if [ -n "$PIDS" ]; then
  wait
fi
