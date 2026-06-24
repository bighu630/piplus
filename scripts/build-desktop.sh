#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     piplus desktop build             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

# ── 1. API bundle ──────────────────────────────────────────
echo "[1/4] Building API bundle ..."
cd apps/api
bun run build:bundle
cd "$OLDPWD"

# ── 2. Web build (desktop) ──────────────────────────────────
echo "[2/4] Building web for desktop ..."
cd apps/web
bun run build:desktop
cd "$OLDPWD"

# ── 3. Desktop compile ──────────────────────────────────────
echo "[3/4] Building desktop main/preload ..."
cd apps/desktop
bun run build
cd "$OLDPWD"

# ── 4. Package ──────────────────────────────────────────────
echo "[4/4] Packaging for Linux ..."
cd apps/desktop

# 清理上次产物，避免 asar 膨胀
rm -rf dist/linux-unpacked dist/*.AppImage dist/*.deb

TARGET="${1:-linux}"
case "$TARGET" in
  linux)
    bunx electron-builder --linux
    echo ""
    echo "  ✅ AppImage: apps/desktop/dist/piplus-0.1.0.AppImage"
    echo "  ✅ deb:      apps/desktop/dist/piplus_0.1.0_amd64.deb"
    ;;
  mac)
    bunx electron-builder --mac
    echo ""
    echo "  ✅ dmg: apps/desktop/dist/piplus-0.1.0.dmg"
    ;;
  win)
    bunx electron-builder --win
    echo ""
    echo "  ✅ exe: apps/desktop/dist/piplus Setup 0.1.0.exe"
    ;;
  *)
    echo "Usage: $0 [linux|mac|win]"
    exit 1
    ;;
esac

echo ""
echo "  Done."
