#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     piplus desktop build             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

VERSION=$(jq -r '.version' apps/desktop/package.json)
TARGET="${1:-linux}"
ARCH="${2:-}"

# ── 1. Compile API binary (bun build --compile) ───────────
echo "[1/4] Compiling API binary (target: $TARGET) ..."
cd apps/api
rm -rf dist
case "$TARGET" in
  win)
    bun build --compile src/index.ts --target=bun-windows-x64 --outfile dist/piplus-api.exe
    ;;
  mac)
    if [ "$ARCH" = "arm64" ]; then
      BUN_TARGET="bun-darwin-arm64"
    else
      BUN_TARGET="bun-darwin-x64"
    fi
    bun build --compile src/index.ts --target="$BUN_TARGET" --outfile dist/piplus-api
    ;;
  linux)
    # musl 构建提升跨发行版兼容性（避免 glibc 版本门槛）；
    # 若遇到 pty 原生库兼容问题，可退回 host 构建：bun build --compile src/index.ts --outfile dist/piplus-api
    bun build --compile src/index.ts --target=bun-linux-x64-musl --outfile dist/piplus-api
    ;;
  *)
    echo "Usage: $0 [linux|mac|win]"
    exit 1
    ;;
esac
cd "$OLDPWD"
API_BINARY="apps/api/dist/piplus-api"
[ "$TARGET" = "win" ] && API_BINARY="apps/api/dist/piplus-api.exe"
if [ ! -f "$API_BINARY" ]; then
  echo "  ❌ ERROR: API binary not found at $API_BINARY"
  echo "     Step 1 (API compile) may have silently failed."
  exit 1
fi
echo "  ✅ API binary verified: $API_BINARY"

# ── 2. Web build (desktop) ──────────────────────────────────
# Export version for Vite define injection
export APP_VERSION="$VERSION"
echo "[2/4] Building web for desktop ..."
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
echo "[3/4] Building desktop main/preload ..."
cd apps/desktop
bun run build
cd "$OLDPWD"
if [ ! -f "apps/desktop/dist/main/index.js" ] || [ ! -f "apps/desktop/dist/preload/index.js" ]; then
  echo "  ❌ ERROR: Desktop dist not found at apps/desktop/dist/main/index.js or apps/desktop/dist/preload/index.js"
  echo "     Step 3 (Desktop compile) may have silently failed."
  exit 1
fi
echo "  ✅ Desktop dist verified."
echo "  → Version: $VERSION"

echo "  Verifying all extraResources sources before packaging..."
MISSING=""
[ -f "$API_BINARY" ] || MISSING="$MISSING  - $API_BINARY\n"
[ -f "apps/web/dist/index.html" ] || MISSING="$MISSING  - apps/web/dist/index.html\n"
[ -f "apps/desktop/dist/main/index.js" ] || MISSING="$MISSING  - apps/desktop/dist/main/index.js\n"
[ -f "apps/desktop/dist/preload/index.js" ] || MISSING="$MISSING  - apps/desktop/dist/preload/index.js\n"
[ -d "apps/migrations" ] || MISSING="$MISSING  - apps/migrations/\n"
[ -d "apps/desktop/assets" ] || MISSING="$MISSING  - apps/desktop/assets/\n"

if [ -n "$MISSING" ]; then
  echo "  ❌ ERROR: The following extraResources sources are missing:"
  printf "%b" "$MISSING"
  echo "     electron-builder will silently skip missing sources, producing an incomplete package."
  exit 1
fi
echo "  ✅ All extraResources sources verified."

# ── 4. Package ──────────────────────────────────────────────
echo "[4/4] Packaging${TARGET:+ for $TARGET} ..."
cd apps/desktop

# 清理上次产物
case "$TARGET" in
  linux) rm -rf dist/linux-unpacked dist/*.AppImage dist/*.deb dist/*.rpm ;;
  mac)   rm -rf dist/mac dist/*.dmg ;;
  win)   rm -rf dist/win-unpacked dist/*.exe ;;
esac

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
