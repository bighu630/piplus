#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     piplus desktop (Tauri) build     ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

TARGET="${1:-linux}"
ARCH="${2:-}"
RELEASE=""

# Parse arguments
for arg in "$@"; do
  case "$arg" in
    --release) RELEASE="--release" ;;
    linux|mac|win) TARGET="$arg" ;;
  esac
done

# Resolve APP_VERSION from desktop-tauri/package.json (or fallback)
APP_VERSION="${APP_VERSION:-$(jq -r '.version' apps/desktop-tauri/package.json 2>/dev/null || echo "0.2.9")}"

# ── 1. API bundle ──────────────────────────────────────────
echo "[1/6] Building API bundle ..."
cd apps/api
bun run build:bundle
cd "$OLDPWD"
if [ ! -f "apps/api/dist/index.js" ]; then
  echo "  ❌ ERROR: API dist not found at apps/api/dist/index.js"
  echo "     Step 1 (API build) may have silently failed."
  exit 1
fi
echo "  ✅ API dist verified."

# ── 2. Web build (desktop) ──────────────────────────────────
echo "[2/6] Building web for desktop ..."
cd apps/web
APP_VERSION="${APP_VERSION}" bun run build:desktop
cd "$OLDPWD"
if [ ! -f "apps/web/dist/index.html" ]; then
  echo "  ❌ ERROR: Web dist not found at apps/web/dist/index.html"
  echo "     Step 2 (Web build) may have silently failed."
  exit 1
fi
echo "  ✅ Web dist verified."

# ── 3. Prepare external resources ───────────────────────────
echo "[3/6] Preparing external resources for Tauri bundle ..."

# Clean and recreate external directories
rm -rf apps/desktop-tauri/src-tauri/external
mkdir -p apps/desktop-tauri/src-tauri/external/{api-dist,web-dist,migrations,bun-bin,pty-libs}

# Copy API dist
echo "  → Copying API dist ..."
cp -r apps/api/dist/* apps/desktop-tauri/src-tauri/external/api-dist/
echo "  ✅ API dist copied."

# Copy web dist
echo "  → Copying web dist ..."
cp -r apps/web/dist/* apps/desktop-tauri/src-tauri/external/web-dist/
echo "  ✅ Web dist copied."

# Copy migrations
echo "  → Copying migrations ..."
if [ -d "apps/migrations" ]; then
  cp -r apps/migrations/* apps/desktop-tauri/src-tauri/external/migrations/
  echo "  ✅ Migrations copied."
else
  echo "  ⚠️  apps/migrations/ not found, skipping."
fi

# Copy bun binary
echo "  → Copying bun binary ..."
BUN_SOURCE="${PIPLUS_BUN_SOURCE:-$(command -v bun || true)}"
if [ -z "$BUN_SOURCE" ] || [ ! -f "$BUN_SOURCE" ]; then
  echo "  ❌ Could not locate a bun executable to bundle."
  echo "     Ensure 'bun' is on PATH, or set PIPLUS_BUN_SOURCE=/path/to/bun"
  exit 1
fi
cp "$BUN_SOURCE" apps/desktop-tauri/src-tauri/external/bun-bin/bun
chmod +x apps/desktop-tauri/src-tauri/external/bun-bin/bun
echo "  ✅ bun bundled from $BUN_SOURCE"

# Copy pty native libs (from API dist after build:bundle)
echo "  → Copying bun-pty native libs ..."
PTY_SRC="apps/api/dist/rust-pty/target/release"
if [ -d "$PTY_SRC" ] && [ "$(ls -A "$PTY_SRC" 2>/dev/null)" ]; then
  cp -r "$PTY_SRC"/* apps/desktop-tauri/src-tauri/external/pty-libs/
  echo "  ✅ bun-pty native libs copied."
else
  echo "  ⚠️  bun-pty native libs not found at $PTY_SRC"
  echo "     (pty-libs are optional; terminal features may be unavailable)"
fi

echo ""
echo "  External resources prepared at:"
echo "    apps/desktop-tauri/src-tauri/external/"

# ── 4. Verify all resources ─────────────────────────────────
echo "[4/6] Verifying all resources ..."
MISSING=""
WARNINGS=""

[ -f "apps/api/dist/index.js" ] || MISSING="$MISSING  - apps/api/dist/index.js\n"
[ -f "apps/web/dist/index.html" ] || MISSING="$MISSING  - apps/web/dist/index.html\n"

# Tauri external resources
[ -f "apps/desktop-tauri/src-tauri/external/api-dist/index.js" ] || MISSING="$MISSING  - apps/desktop-tauri/src-tauri/external/api-dist/index.js\n"
[ -f "apps/desktop-tauri/src-tauri/external/web-dist/index.html" ] || MISSING="$MISSING  - apps/desktop-tauri/src-tauri/external/web-dist/index.html\n"
[ -f "apps/desktop-tauri/src-tauri/external/bun-bin/bun" ] || MISSING="$MISSING  - apps/desktop-tauri/src-tauri/external/bun-bin/bun\n"
[ -d "apps/migrations" ] || WARNINGS="$WARNINGS  ⚠️  apps/migrations/ not found\n"

# Icons check
ICON_COUNT=$(find apps/desktop-tauri/src-tauri/icons -name '*.png' -type f 2>/dev/null | wc -l)
if [ "$ICON_COUNT" -lt 3 ]; then
  WARNINGS="$WARNINGS  ⚠️  Tauri icons missing or incomplete (found $ICON_COUNT PNGs)\n"
fi

if [ -n "$WARNINGS" ]; then
  echo "  ⚠️  Warnings (non-fatal):"
  printf "%b" "$WARNINGS"
fi
if [ -n "$MISSING" ]; then
  echo "  ❌ ERROR: The following resources are missing:"
  printf "%b" "$MISSING"
  exit 1
fi
echo "  ✅ All critical resources verified."

# ── 5. Generate icons (if missing) ──────────────────────────
echo "[5/6] Checking Tauri icons ..."
ICON_SRC="apps/desktop/assets/icon.png"
if [ "$ICON_COUNT" -lt 3 ] && [ -f "$ICON_SRC" ]; then
  echo "  → Regenerating icons from $ICON_SRC ..."
  cd apps/desktop-tauri/src-tauri
  cargo tauri icon --output icons "../../../$ICON_SRC" 2>&1 | sed 's/^/    /'
  cd "$OLDPWD"
  echo "  ✅ Icons regenerated."
elif [ "$ICON_COUNT" -ge 3 ]; then
  echo "  ✅ Icons already present ($ICON_COUNT PNGs)."
else
  echo "  ⚠️  Source icon not found at $ICON_SRC"
  echo "     Run 'cargo tauri icon <source-png>' manually to generate icons."
fi

# ── 6. Cargo build ──────────────────────────────────────────
echo "[6/6] Running cargo build${RELEASE:+ --release} ..."
cd apps/desktop-tauri/src-tauri
if [ -n "$RELEASE" ]; then
  cargo build --release
else
  cargo build
fi
cd "$OLDPWD"

BINARY_PATH="apps/desktop-tauri/src-tauri/target/${RELEASE:+release}${RELEASE:-debug}/piplus-desktop"

echo ""
echo "  ✅ Build complete."
echo "  Target:    ${TARGET}"
echo "  Version:   ${APP_VERSION}"
echo ""
echo "  Binary: ${BINARY_PATH}"
echo ""
echo "  To run in development mode:"
echo "    cd apps/desktop-tauri && bun run tauri dev"
echo ""
echo "  Done."