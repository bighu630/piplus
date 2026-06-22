#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# ── load .env ──────────────────────────────────────────────
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3002}"

# ── LAN address ────────────────────────────────────────────
detect_lan_ip() {
  local ip=""
  # prefer ipv4 on common interfaces
  for iface in eth0 en0 wlan0 ens33 enp0s3; do
    ip=$(ip -4 addr show "$iface" 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | head -n1)
    [ -n "$ip" ] && { echo "$ip"; return; }
  done
  # fallback: any non-loopback ipv4
  ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  [ -n "$ip" ] && { echo "$ip"; return; }
  echo "127.0.0.1"
}

LAN_IP=$(detect_lan_ip)

# ── banner ─────────────────────────────────────────────────
echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║              piplus                      ║"
echo "  ╠══════════════════════════════════════════╣"
printf "  ║  API  · http://localhost:%-5s          ║\n" "$API_PORT"
printf "  ║  Web  · http://localhost:%-5s          ║\n" "$WEB_PORT"
echo "  ╠══════════════════════════════════════════╣"
printf "  ║  LAN  · http://%s:%-5s          ║\n" "$LAN_IP" "$WEB_PORT"
echo "  ╚══════════════════════════════════════════╝"
echo ""

if [ -z "${APP_PASSWORD:-}" ]; then
  echo "  ⚠  APP_PASSWORD not set, using default: piplus-local"
fi

echo ""

# ── clean stale cache ─────────────────────────────────────
rm -rf apps/web/.next

# ── launch ─────────────────────────────────────────────────
echo "[piplus] starting API on port ${API_PORT} ..."
bun run apps/api/src/index.ts &
API_PID=$!

sleep 1

echo "[piplus] starting Web on port ${WEB_PORT} ..."
cd apps/web && npx vite --host 0.0.0.0 --port "${WEB_PORT}" &
WEB_PID=$!

trap 'echo; echo "[piplus] shutting down..."; kill '"$API_PID"' '"$WEB_PID"' 2>/dev/null; exit' INT TERM

wait
