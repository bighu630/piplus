#!/usr/bin/env bash
#
# 安装仓库 git hooks：core.hooksPath -> .githooks
#
# 幂等，可重复执行。根 package.json 的 "prepare" 会在 bun install 时自动调用它，
# 因此新 clone / 新 worktree 只需 bun install 即可装上 hooks。
#
# 用法：
#   bash scripts/setup-hooks.sh          安装（已安装则直接返回）
#   bash scripts/setup-hooks.sh --check  只检查不修改，未安装则 exit 1
#   bash scripts/setup-hooks.sh --force  覆盖已有的其他 core.hooksPath
set -euo pipefail

HOOKS_DIR=".githooks"
MODE="install"

for arg in "$@"; do
  case "$arg" in
    --check) MODE="check" ;;
    --force) MODE="force" ;;
    -h|--help)
      sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "未知参数：$arg（可用：--check / --force）" >&2
      exit 2
      ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "setup-hooks: 不在 git 仓库内" >&2
  exit 1
}
cd "$ROOT"

if [ ! -d "$HOOKS_DIR" ]; then
  echo "setup-hooks: 找不到 $HOOKS_DIR/" >&2
  exit 1
fi

CURRENT="$(git config --local --get core.hooksPath 2>/dev/null || true)"

if [ "$MODE" = "check" ]; then
  if [ "$CURRENT" = "$HOOKS_DIR" ]; then
    echo "✅ hooks 已安装（core.hooksPath=$CURRENT）"
    exit 0
  fi
  echo "❌ hooks 未安装（当前 core.hooksPath=${CURRENT:-<未设置>}）" >&2
  echo "   运行：bash scripts/setup-hooks.sh" >&2
  exit 1
fi

if [ -n "$CURRENT" ] && [ "$CURRENT" != "$HOOKS_DIR" ] && [ "$MODE" != "force" ]; then
  echo "❌ 本仓库已有其他 core.hooksPath=$CURRENT，拒绝覆盖" >&2
  echo "   确认要改成 $HOOKS_DIR 时：bash scripts/setup-hooks.sh --force" >&2
  exit 1
fi

chmod +x "$HOOKS_DIR"/* 2>/dev/null || true

if [ "$CURRENT" = "$HOOKS_DIR" ]; then
  echo "✅ hooks 已安装（core.hooksPath=$CURRENT）"
else
  git config --local core.hooksPath "$HOOKS_DIR"
  echo "✅ 已设置 core.hooksPath=$HOOKS_DIR"
fi

echo "   pre-merge-commit  拦：在 main 上做非 FF 合并"
echo "   pre-push          拦：推送到 refs/heads/main（覆盖 FF / squash）"
