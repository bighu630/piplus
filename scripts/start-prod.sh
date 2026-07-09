#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# ── load .env ──────────────────────────────────────────────
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# ── color helpers ──────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

echo ""
echo "  ╔══════════════════════════════════════════╗"
echo "  ║        piplus · production               ║"
echo "  ╚══════════════════════════════════════════╝"
echo ""

# ── defaults ───────────────────────────────────────────────
API_HOST="${API_HOST:-0.0.0.0}"
API_PORT="${API_PORT:-3001}"
PUBLIC_ORIGIN="${PUBLIC_WEB_ORIGIN:-}"

WEB_DIST="${PIPLUS_WEB_DIST:-$PWD/apps/web/dist}"

# ── validate ───────────────────────────────────────────────
if [ -z "$PUBLIC_ORIGIN" ]; then
  echo -e "  ${RED}❌ PUBLIC_WEB_ORIGIN is not set${NC}"
  echo "     Set it to your public URL, e.g.:"
  echo "     PUBLIC_WEB_ORIGIN=https://piplus.whosworld.fun"
  echo ""
  exit 1
fi

# ── build web if not already built ─────────────────────────
if [ ! -f "$WEB_DIST/index.html" ]; then
  echo -e "  ${CYAN}📦 Building web frontend ...${NC}"
  cd apps/web
  bun run build
  cd "$OLDPWD"
  echo -e "  ${GREEN}  ✅ Web built${NC}"
else
  echo -e "  ${GREEN}  ✅ Web dist found at ${WEB_DIST}${NC}"
fi

# ── banner ─────────────────────────────────────────────────
echo ""
echo -e "  ${CYAN}🌐 Public URL:${NC}  ${PUBLIC_ORIGIN}"
echo -e "  ${CYAN}🔌 API:${NC}         http://${API_HOST}:${API_PORT}"
echo ""

# ── launch API (serves API + web) ─────────────────────────
export API_HOST
export API_PORT
export PIPLUS_SERVE_WEB=1
export PIPLUS_WEB_DIST="$WEB_DIST"
export PUBLIC_WEB_ORIGIN="$PUBLIC_ORIGIN"

echo -e "  ${CYAN}🚀 Starting piplus API server ...${NC}"
echo ""

exec bun run apps/api/src/index.ts
