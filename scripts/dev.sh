#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Load .env if it exists
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"

echo "=== piplus dev ==="
echo "API : http://localhost:${API_PORT}"
echo "Web : http://localhost:${WEB_PORT}"
echo ""

echo "Starting API..."
bun run apps/api/src/index.ts &
API_PID=$!

sleep 2

echo "Starting Web..."
NEXT_PUBLIC_API_PORT="${API_PORT}" bun --cwd apps/web dev -p "${WEB_PORT}" &
WEB_PID=$!

trap "kill $API_PID $WEB_PID 2>/dev/null; exit" INT TERM

wait
