#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     piplus desktop build             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. API bundle ──────────────────────────────────────────
echo "[1/5] Building API bundle ..."
cd apps/api
bun run build:bundle
cd "$OLDPWD"

# ── 2. Web build (desktop) ──────────────────────────────────
echo "[2/5] Building web for desktop ..."
cd apps/web
bun run build:desktop
cd "$OLDPWD"

# ── 3. Desktop compile ──────────────────────────────────────
echo "[3/5] Building desktop main/preload ..."
cd apps/desktop
bun run build
cd "$OLDPWD"

VERSION=$(jq -r '.version' apps/desktop/package.json)
echo "  → Version: $VERSION"

TARGET="${1:-linux}"

# ── 4. Prepare bundled bun ──────────────────────────────────
echo "[4/5] Preparing bundled bun ..."

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

# ── 5. Package ──────────────────────────────────────────────
echo "[5/5] Packaging${TARGET:+ for $TARGET} ..."
cd apps/desktop

# 清理上次产物，避免 asar 膨胀
case "$TARGET" in
  linux) rm -rf dist/linux-unpacked dist/*.AppImage dist/*.deb ;;
  mac)   rm -rf dist/mac dist/*.dmg ;;
  win)   rm -rf dist/win-unpacked dist/*.exe ;;
esac

case "$TARGET" in
  linux)
    bunx electron-builder --linux
    echo ""
    echo "  ✅ AppImage: apps/desktop/dist/piplus-${VERSION}.AppImage"
    echo "  ✅ deb:      apps/desktop/dist/piplus_${VERSION}_amd64.deb"
    ;;
  mac)
    bunx electron-builder --mac
    echo ""
    echo "  ✅ dmg: apps/desktop/dist/piplus-${VERSION}.dmg"
    ;;
  win)
    bunx electron-builder --win
    # Rename to avoid spaces in filename (GitHub upload issue)
    if [ -f "dist/piplus Setup ${VERSION}.exe" ]; then
      mv "dist/piplus Setup ${VERSION}.exe" "dist/piplus-${VERSION}.exe"
    fi
    if [ -f "dist/piplus Setup ${VERSION}.exe.blockmap" ]; then
      mv "dist/piplus Setup ${VERSION}.exe.blockmap" "dist/piplus-${VERSION}.exe.blockmap"
    fi
    echo ""
    echo "  ✅ exe: apps/desktop/dist/piplus-${VERSION}.exe"
    ;;
  *)
    echo "Usage: $0 [linux|mac|win]"
    exit 1
    ;;
esac

echo ""
echo "  Done."
