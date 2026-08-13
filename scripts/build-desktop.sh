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
    # ARCH 为空时用宿主架构推导（uname -m），使 BUN_TARGET 与第 4 步
    # electron-builder 的 --$ARCH（未传时默认取宿主架构）保持一致：
    # 否则 Apple Silicon 上会固定打出 x64 API 二进制 + arm64 .app（需 Rosetta）。
    if [ -z "$ARCH" ]; then
      case "$(uname -m)" in
        arm64|aarch64) ARCH="arm64" ;;
        *) ARCH="x64" ;;
      esac
    fi
    if [ "$ARCH" = "arm64" ]; then
      BUN_TARGET="bun-darwin-arm64"
    else
      BUN_TARGET="bun-darwin-x64"
    fi
    bun build --compile src/index.ts --target="$BUN_TARGET" --outfile dist/piplus-api
    ;;
  linux)
    # 历史决策：曾用 --target=bun-linux-x64-musl 提升跨发行版兼容性，
    # 但 bun 1.3.x 的 musl 编译产物是动态链接的（依赖系统安装的
    # /lib/ld-musl-x86_64.so.1 + libc.musl），绝大多数桌面发行版默认无
    # musl loader，二进制直接无法启动（cannot execute: required file not found）。
    # bun 亦无静态 musl 选项（oven-sh/bun#23910），故退回 host（glibc）构建。
    # 已知限制：产物要求主机 glibc >= 2.43（bun 1.3.14 编译符号需求）。
    bun build --compile src/index.ts --outfile dist/piplus-api
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
esac

echo ""
echo "  Done."
