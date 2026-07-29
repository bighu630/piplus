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
# Tauri v2 externalBin appends target triple suffix, so we need to name it correctly
echo "  → Copying bun binary ..."
TARGET_TRIPLE=$(rustc -vV | grep host | awk '{print $2}')
BUN_SOURCE="${PIPLUS_BUN_SOURCE:-$(command -v bun || true)}"
if [ -z "$BUN_SOURCE" ] || [ ! -f "$BUN_SOURCE" ]; then
  echo "  ❌ Could not locate a bun executable to bundle."
  echo "     Ensure 'bun' is on PATH, or set PIPLUS_BUN_SOURCE=/path/to/bun"
  exit 1
fi

# Tauri v2 looks for externalBin paths with target triple suffix appended
# e.g., "external/bun-bin/bun" → "external/bun-bin/bun-x86_64-unknown-linux-gnu"
cp "$BUN_SOURCE" "apps/desktop-tauri/src-tauri/external/bun-bin/bun-${TARGET_TRIPLE}"
chmod +x "apps/desktop-tauri/src-tauri/external/bun-bin/bun-${TARGET_TRIPLE}"
# Also create a symlink without target triple for runtime resolution
ln -sf "bun-${TARGET_TRIPLE}" "apps/desktop-tauri/src-tauri/external/bun-bin/bun"
echo "  ✅ bun bundled as bun-${TARGET_TRIPLE} from $BUN_SOURCE"

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
[ -f "apps/desktop-tauri/src-tauri/external/bun-bin/bun" ] || [ -f "apps/desktop-tauri/src-tauri/external/bun-bin/bun-$(rustc -vV 2>/dev/null | grep host | awk '{print $2}')" ] || MISSING="$MISSING  - apps/desktop-tauri/src-tauri/external/bun-bin/bun\n"
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

# ── 6. Filter non-native pty libs ────────────────────────────
echo "[6/7] Filtering non-native pty libs ..."
PTY_DIR="apps/desktop-tauri/src-tauri/external/api-dist/rust-pty/target/release"
if [ -d "$PTY_DIR" ]; then
  rm -f "$PTY_DIR"/*arm64* "$PTY_DIR"/*musl* "$PTY_DIR"/*.dylib "$PTY_DIR"/*.dll 2>/dev/null
  echo "  ✅ Filtered non-native pty libs from api-dist"
fi
PTY_DIR2="apps/desktop-tauri/src-tauri/external/pty-libs"
if [ -d "$PTY_DIR2" ]; then
  rm -f "$PTY_DIR2"/*arm64* "$PTY_DIR2"/*musl* "$PTY_DIR2"/*.dylib "$PTY_DIR2"/*.dll 2>/dev/null
  echo "  ✅ Filtered non-native pty libs from pty-libs"
fi

# ── 7. Cargo build ──────────────────────────────────────────
echo "[7/7] Running cargo tauri build${RELEASE:+ --release} ..."
cd apps/desktop-tauri/src-tauri

if [ "$TARGET" = "linux" ] && [ -n "$RELEASE" ]; then
  NO_STRIP=1 cargo tauri build
else
  cargo tauri build
fi
cd "$OLDPWD"

BINARY_PATH="apps/desktop-tauri/src-tauri/target/${RELEASE:+release}${RELEASE:-debug}/piplus-desktop"

# ── 8. Rename artifacts to match Electron naming convention ──
if [ -n "$RELEASE" ]; then
  echo "[8/8] Renaming artifacts (Electron naming + -tauri suffix) ..."
  BUNDLE_DIR="apps/desktop-tauri/src-tauri/target/release/bundle"
  VERSION="${APP_VERSION}"
  
  # Determine arch label
  ARCH_LABEL=$(uname -m)
  case "$ARCH_LABEL" in
    x86_64)  ARCH_LABEL="amd64" ;;
    aarch64) ARCH_LABEL="arm64" ;;
  esac
  
  # Rename deb
  if [ -f "$BUNDLE_DIR/deb/"*.deb ]; then
    OLD_DEB=$(ls $BUNDLE_DIR/deb/*.deb | head -1)
    NEW_DEB="$BUNDLE_DIR/deb/piplus-${VERSION}-linux-${ARCH_LABEL}-tauri.deb"
    mv "$OLD_DEB" "$NEW_DEB"
    echo "  → $(basename $NEW_DEB)"
  fi
  
  # Rename rpm
  if [ -f "$BUNDLE_DIR/rpm/"*.rpm ]; then
    OLD_RPM=$(ls $BUNDLE_DIR/rpm/*.rpm | head -1)
    NEW_RPM="$BUNDLE_DIR/rpm/piplus-${VERSION}-linux-${ARCH_LABEL}-tauri.rpm"
    mv "$OLD_RPM" "$NEW_RPM"
    echo "  → $(basename $NEW_RPM)"
  fi
  
  # Rename AppImage
  if [ -f "$BUNDLE_DIR/appimage/"*.AppImage ]; then
    OLD_APPIMAGE=$(ls $BUNDLE_DIR/appimage/*.AppImage | head -1)
    NEW_APPIMAGE="$BUNDLE_DIR/appimage/piplus-${VERSION}-linux-${ARCH_LABEL}-tauri.AppImage"
    mv "$OLD_APPIMAGE" "$NEW_APPIMAGE"
    echo "  → $(basename $NEW_APPIMAGE)"
  fi
  
  # Rename DMG (macOS)
  if [ -d "$BUNDLE_DIR/dmg" ] && [ -f "$BUNDLE_DIR/dmg/"*.dmg ]; then
    OLD_DMG=$(ls $BUNDLE_DIR/dmg/*.dmg | head -1)
    NEW_DMG="$BUNDLE_DIR/dmg/piplus-${VERSION}-mac-${ARCH_LABEL}-tauri.dmg"
    mv "$OLD_DMG" "$NEW_DMG"
    echo "  → $(basename $NEW_DMG)"
  fi
  
  # Rename Windows installers
  if [ -d "$BUNDLE_DIR/nsis" ] && [ -f "$BUNDLE_DIR/nsis/"*.exe ]; then
    OLD_EXE=$(ls $BUNDLE_DIR/nsis/*.exe | head -1)
    NEW_EXE="$BUNDLE_DIR/nsis/piplus-${VERSION}-win-${ARCH_LABEL}-tauri.exe"
    mv "$OLD_EXE" "$NEW_EXE"
    echo "  → $(basename $NEW_EXE)"
  fi
  
  if [ -d "$BUNDLE_DIR/msi" ] && [ -f "$BUNDLE_DIR/msi/"*.msi ]; then
    OLD_MSI=$(ls $BUNDLE_DIR/msi/*.msi | head -1)
    NEW_MSI="$BUNDLE_DIR/msi/piplus-${VERSION}-win-${ARCH_LABEL}-tauri.msi"
    mv "$OLD_MSI" "$NEW_MSI"
    echo "  → $(basename $NEW_MSI)"
  fi
  
  echo "  ✅ Artifacts renamed."
fi

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