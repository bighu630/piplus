#!/usr/bin/env bash
# Copies bun-pty native libraries (for all platforms) into the API dist directory.
# This ensures AppImage/mac/win bundled builds can find librust_pty at runtime.
set -euo pipefail

cd "$(dirname "$0")/.."

PTY_DIR=$(node -e "console.log(require('path').dirname(require.resolve('bun-pty/package.json'))+'/rust-pty/target/release')")
DIST_DIR="apps/api/dist/rust-pty/target/release"

if [ -d "$PTY_DIR" ]; then
  mkdir -p "$DIST_DIR"
  cp -r "$PTY_DIR"/* "$DIST_DIR/"
  echo "[copy-pty-libs] Copied native libraries from $PTY_DIR to $DIST_DIR"
else
  echo "[copy-pty-libs] Warning: bun-pty native libs not found at $PTY_DIR"
fi
