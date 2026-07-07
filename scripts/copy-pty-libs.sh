#!/usr/bin/env bash
# Copies bun-pty native libraries (for all platforms) into the API dist directory.
# This ensures AppImage/mac/win bundled builds can find librust_pty at runtime.
set -euo pipefail

cd "$(dirname "$0")/.."

# Find bun-pty package directory (works with both bun's .bun cache and npm)
PTY_DIR=""
if [ -d "node_modules/bun-pty" ]; then
  PTY_DIR="node_modules/bun-pty/rust-pty/target/release"
elif [ -d "apps/api/node_modules/bun-pty" ]; then
  PTY_DIR="apps/api/node_modules/bun-pty/rust-pty/target/release"
else
  # Try bun's virtual store
  PTY_DIR=$(find node_modules/.bun -maxdepth 2 -name "bun-pty*" -type d 2>/dev/null | head -1)
  if [ -n "$PTY_DIR" ]; then
    PTY_DIR="$PTY_DIR/node_modules/bun-pty/rust-pty/target/release"
  fi
fi

DIST_DIR="apps/api/dist/rust-pty/target/release"

if [ -n "$PTY_DIR" ] && [ -d "$PTY_DIR" ]; then
  mkdir -p "$DIST_DIR"
  cp -r "$PTY_DIR"/* "$DIST_DIR/"
  echo "[copy-pty-libs] ✅ Copied native libs from $PTY_DIR to $DIST_DIR"
  ls -la "$DIST_DIR"
else
  echo "[copy-pty-libs] ❌ ERROR: bun-pty native libs not found!"
  echo "  Searched:"
  echo "  - node_modules/bun-pty"
  echo "  - apps/api/node_modules/bun-pty"
  echo "  - node_modules/.bun/bun-pty-*"
  find node_modules/.bun -maxdepth 3 -name "bun-pty*" -type d 2>/dev/null || true
  exit 1
fi
