#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     piplus desktop build             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

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
# Export version for Vite define injection
export APP_VERSION=$(jq -r '.version' apps/desktop/package.json)
echo "[2/6] Building web for desktop ..."
cd apps/web
bun run build:desktop
cd "$OLDPWD"
if [ ! -f "apps/web/dist/index.html" ]; then
  echo "  ❌ ERROR: Web dist not found at apps/web/dist/index.html"
  echo "     Step 2 (Web build) may have silently failed."
  exit 1
fi
echo "  ✅ Web dist verified."

# ── 3. Desktop compile ──────────────────────────────────────
echo "[3/6] Building desktop main/preload ..."
cd apps/desktop
bun run build
cd "$OLDPWD"
if [ ! -f "apps/desktop/dist/main/index.js" ] || [ ! -f "apps/desktop/dist/preload/index.js" ]; then
  echo "  ❌ ERROR: Desktop dist not found at apps/desktop/dist/main/index.js or apps/desktop/dist/preload/index.js"
  echo "     Step 3 (Desktop compile) may have silently failed."
  exit 1
fi
echo "  ✅ Desktop dist verified."

VERSION="${APP_VERSION}"
echo "  → Version: $VERSION"

TARGET="${1:-linux}"
ARCH="${2:-}"

# ── 4. Prepare bundled bun ──────────────────────────────────
echo "[4/6] Preparing bundled bun ..."

# Clean up any previous bun-bin
rm -rf apps/desktop/bun-bin

if [ "$TARGET" = "win" ]; then
  if [ -n "${PIPLUS_BUN_WIN_PATH:-}" ] && [ -f "$PIPLUS_BUN_WIN_PATH" ]; then
    mkdir -p apps/desktop/bun-bin
    cp "$PIPLUS_BUN_WIN_PATH" apps/desktop/bun-bin/bun.exe
    echo "  → bun.exe bundled from PIPLUS_BUN_WIN_PATH ($PIPLUS_BUN_WIN_PATH)"
  else
    echo "  ⚠️  PIPLUS_BUN_WIN_PATH is not set or file not found."
    echo "  → Attempting to download bun for Windows ..."
    mkdir -p apps/desktop/bun-bin
    if command -v curl &>/dev/null; then
      BUN_ZIP="/tmp/bun-windows-x64.zip"
      BUN_EXTRACT="/tmp/bun-windows-extract"
      rm -rf "$BUN_EXTRACT" "$BUN_ZIP"
      curl -fsSL "https://github.com/oven-sh/bun/releases/latest/download/bun-windows-x64.zip" \
        -o "$BUN_ZIP" 2>/dev/null || {
        echo "  ❌ Download failed. To bundle bun.exe:"
        echo "     $$ PIPLUS_BUN_WIN_PATH=/path/to/bun.exe $0 win"
        echo "  → Continuing without bundled bun (Windows may need system Bun)."
        rm -rf apps/desktop/bun-bin
      }
      if [ -f "$BUN_ZIP" ]; then
        if command -v unzip &>/dev/null; then
          mkdir -p "$BUN_EXTRACT"
          unzip -o "$BUN_ZIP" -d "$BUN_EXTRACT" 2>/dev/null
          # Find bun.exe inside the extracted tree (may be nested, e.g. bun-windows-x64/bun.exe)
          FOUND_BUN=$(find "$BUN_EXTRACT" -name 'bun.exe' -type f 2>/dev/null | head -1)
          if [ -n "$FOUND_BUN" ] && [ -f "$FOUND_BUN" ]; then
            cp "$FOUND_BUN" apps/desktop/bun-bin/bun.exe
            echo "  → bun.exe downloaded and extracted to apps/desktop/bun-bin/bun.exe"
          else
            echo "  ❌ Extracted archive does not contain bun.exe"
            rm -rf apps/desktop/bun-bin
          fi
          rm -rf "$BUN_EXTRACT"
        else
          echo "  ❌ 'unzip' not found. Please install unzip or set PIPLUS_BUN_WIN_PATH."
          rm -rf apps/desktop/bun-bin
        fi
        rm -f "$BUN_ZIP"
      fi
    else
      echo "  ❌ 'curl' not found. Please set PIPLUS_BUN_WIN_PATH:"
      echo "     $$ PIPLUS_BUN_WIN_PATH=/path/to/bun.exe $0 win"
      rm -rf apps/desktop/bun-bin
    fi
  fi
elif [ "$TARGET" = "mac" ] || [ "$TARGET" = "linux" ]; then
  # For mac/linux we bundle the bun binary from the current build machine.
  # (Cross-arch builds should set PIPLUS_BUN_SOURCE to an explicit path.)
  BUN_SOURCE="${PIPLUS_BUN_SOURCE:-$(command -v bun || true)}"
  if [ -z "$BUN_SOURCE" ] || [ ! -f "$BUN_SOURCE" ]; then
    echo "  ❌ Could not locate a bun executable to bundle."
    echo "     Ensure 'bun' is on PATH, or set PIPLUS_BUN_SOURCE=/path/to/bun"
    exit 1
  fi
  mkdir -p apps/desktop/bun-bin
  cp "$BUN_SOURCE" apps/desktop/bun-bin/bun
  chmod +x apps/desktop/bun-bin/bun
  echo "  → bun bundled from $BUN_SOURCE"
fi

# ── 5. Copy pty native libs (electron-builder can't read bun's .bun cache) ──
# bun-pty native libs are pre-compiled and shipped with the npm package.
# electron-builder's extraResources fails on bun's virtual filesystem,
# so we copy them to apps/desktop/pty-libs/ first.
echo "[5/6] Copying bun-pty native libs ..."
rm -rf apps/desktop/pty-libs
PTY_SRC=$(cd apps/api && node -e "console.log(require('path').dirname(require.resolve('bun-pty/package.json'))+'/rust-pty/target/release')" 2>/dev/null || true)
if [ -n "$PTY_SRC" ] && [ -d "$PTY_SRC" ]; then
  mkdir -p apps/desktop/pty-libs
  cp -r "$PTY_SRC"/* apps/desktop/pty-libs/
  echo "  ✅ Copied bun-pty native libs to apps/desktop/pty-libs/"
  ls apps/desktop/pty-libs/ 2>/dev/null | head -10 || true
else
  echo "  ⚠️  bun-pty native libs not found"
  find apps/api/node_modules -name "librust_pty.so" 2>/dev/null | head -3 || true
fi
echo "  Verifying all extraResources sources before packaging..."
MISSING=""
WARNINGS=""
[ -f "apps/api/dist/index.js" ] || MISSING="$MISSING  - apps/api/dist/index.js\n"
[ -f "apps/web/dist/index.html" ] || MISSING="$MISSING  - apps/web/dist/index.html\n"
[ -f "apps/desktop/dist/main/index.js" ] || MISSING="$MISSING  - apps/desktop/dist/main/index.js\n"
[ -f "apps/desktop/dist/preload/index.js" ] || MISSING="$MISSING  - apps/desktop/dist/preload/index.js\n"
[ -d "apps/migrations" ] || MISSING="$MISSING  - apps/migrations/\n"
[ -d "apps/desktop/assets" ] || MISSING="$MISSING  - apps/desktop/assets/\n"
# bun-bin check: require bun.exe on windows, bun otherwise
if [ "$TARGET" = "win" ]; then
  [ -f "apps/desktop/bun-bin/bun.exe" ] || MISSING="$MISSING  - apps/desktop/bun-bin/bun.exe\n"
else
  [ -f "apps/desktop/bun-bin/bun" ] || MISSING="$MISSING  - apps/desktop/bun-bin/bun\n"
fi
# pty-libs is optional (Step 5 warns but continues)
[ -d "apps/desktop/pty-libs" ] || WARNINGS="$WARNINGS  ⚠️  pty-libs not found (terminal features may be unavailable)\n"

if [ -n "$WARNINGS" ]; then
  echo "  ⚠️  Warnings (non-fatal):"
  printf "%b" "$WARNINGS"
fi
if [ -n "$MISSING" ]; then
  echo "  ❌ ERROR: The following extraResources sources are missing:"
  printf "%b" "$MISSING"
  echo "     electron-builder will silently skip missing sources, producing an incomplete package."
  exit 1
fi
if [ -n "$WARNINGS" ]; then
  echo "  ✅ Critical extraResources sources verified (see warnings above)."
else
  echo "  ✅ All extraResources sources verified."
fi

# ── 6. Package ──────────────────────────────────────────────
echo "[6/6] Packaging${TARGET:+ for $TARGET} ..."
cd apps/desktop

# 清理上次产物
case "$TARGET" in
  linux) rm -rf dist/linux-unpacked dist/*.AppImage dist/*.deb dist/*.rpm ;;
  mac)   rm -rf dist/mac dist/*.dmg ;;
  win)   rm -rf dist/win-unpacked dist/*.exe ;;
esac

# pty-libs 已在步骤 5 中复制，此处无需重复清理

case "$TARGET" in
  linux)
    bunx electron-builder --linux
    echo ""
    echo "  ✅ AppImage: dist/piplus-${VERSION}-linux-amd64.AppImage"
    echo "  ✅ deb:      dist/piplus-${VERSION}-linux-amd64.deb"
    echo "  ✅ rpm:      dist/piplus-${VERSION}-linux-amd64.rpm"
    ;;
  mac)
    MAC_ARGS="--mac"
    if [ -n "$ARCH" ]; then
      MAC_ARGS="$MAC_ARGS --$ARCH"
    fi
    bunx electron-builder $MAC_ARGS
    # artifactName 模板用 ${arch} 输出 x64，改为 amd64
    if [ -f "dist/piplus-${VERSION}-mac-x64.dmg" ]; then
      mv "dist/piplus-${VERSION}-mac-x64.dmg" "dist/piplus-${VERSION}-mac-amd64.dmg"
    fi
    echo ""
    echo "  ✅ dmg: dist/piplus-${VERSION}-mac-${ARCH:-amd64}.dmg"
    ;;
  win)
    bunx electron-builder --win
    # artifactName 已处理命名，输出为 piplus-${VERSION}-win-amd64.exe
    echo ""
    echo "  ✅ exe: dist/piplus-${VERSION}-win-amd64.exe"
    ;;
  *)
    echo "Usage: $0 [linux|mac|win]"
    exit 1
    ;;
esac

echo ""
echo "  Done."
