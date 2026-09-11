#!/usr/bin/env bash
#
# 基线检查 —— 合并到 main 前的唯一真相源（full typecheck + 逐包测试）
#
# 调用方：
#   .githooks/pre-merge-commit      本地在 main 上做非 FF 合并时
#   .githooks/pre-push              推送到 refs/heads/main 时（覆盖 FF / squash）
#   .github/workflows/baseline.yml  服务端兜底
#
# 用法：
#   bash scripts/baseline-check.sh
#
# 环境变量：
#   BASELINE_SKIP=1       应急跳过（仅限明确知情时使用）
#   BASELINE_NO_CACHE=1   忽略 tree 缓存，强制实跑（CI 使用）
#   BASELINE_TREE_KEY     覆盖缓存 key（pre-push 传入被推送 commit 的 tree）
#
# 退出码：0 = 全部通过或缓存命中；1 = 有步骤失败 / 前置条件不满足
set -uo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "baseline-check: 不在 git 仓库内，无法定位仓库根" >&2
  exit 1
}
cd "$ROOT" || exit 1

# 必须逐包运行：从仓库根裸跑 `bun test` 会因 CWD 依赖产生大量假失败
# （实测 453 个测试里 65 个失败），且它跑的是全部工作区而不是本包。
PACKAGES=(
  apps/api
  apps/web
  packages/db
  packages/domain
  packages/pi-client
  packages/shared
)

if [ "${BASELINE_SKIP:-}" = "1" ]; then
  echo "⚠️  BASELINE_SKIP=1：跳过基线检查"
  exit 0
fi

# ---- tree 缓存 -------------------------------------------------------------
# key = 即将被检查的那棵树。同一棵树已经通过就不再重复跑：
# 双闸（pre-merge-commit → pre-push）下同一份代码只跑一次。
#
# 默认取 index tree（git write-tree）而不是 HEAD^{tree}：
# pre-merge-commit 阶段合并结果已经进 index，但 merge commit 还没生成，
# HEAD 仍指向合并前的旧提交 —— 用 HEAD^{tree} 当 key 会把"旧树"标记为已通过。
resolve_tree_key() {
  if [ -n "${BASELINE_TREE_KEY:-}" ]; then
    printf '%s' "$BASELINE_TREE_KEY"
    return 0
  fi
  if git write-tree 2>/dev/null; then
    return 0
  fi
  # index 有冲突（write-tree 失败）时退化为 HEAD tree；两者都拿不到则禁用缓存
  git rev-parse 'HEAD^{tree}' 2>/dev/null || printf 'unknown'
}

GIT_COMMON_DIR="$(git rev-parse --git-common-dir 2>/dev/null || printf '.git')"
case "$GIT_COMMON_DIR" in
  /*) ;;
  *) GIT_COMMON_DIR="$ROOT/$GIT_COMMON_DIR" ;;
esac
# 放在 git-common-dir（而非 .git）下，worktree 之间共享同一份缓存
CACHE_FILE="$GIT_COMMON_DIR/baseline-passed-tree"
TREE_KEY="$(resolve_tree_key)"

CACHE_ENABLED=1
if [ "${BASELINE_NO_CACHE:-}" = "1" ] || [ "$TREE_KEY" = "unknown" ]; then
  CACHE_ENABLED=0
fi

# 工作区相对 index 有未 staged 的改动时，“被测内容” ≠ index tree，
# 用 index tree 做 key 会把一棵没真正验证过的树标成已通过 —— 宁可多跑一轮。
# （注意：pre-merge-commit 阶段合并结果全部在 index 里，不会有未 staged 改动，缓存照常生效）
if [ "$CACHE_ENABLED" = "1" ] && ! git diff --quiet -- 2>/dev/null; then
  echo "ℹ️  工作区存在未 staged 的改动：本次不使用缓存（避免误标已通过）"
  CACHE_ENABLED=0
fi

if [ "$CACHE_ENABLED" = "1" ] &&
   [ -f "$CACHE_FILE" ] &&
   [ "$(cat "$CACHE_FILE" 2>/dev/null)" = "$TREE_KEY" ]; then
  echo "✅ 基线缓存命中（tree ${TREE_KEY:0:12}），跳过本轮检查"
  exit 0
fi

# ---- 前置检查 --------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "❌ 找不到 bun，无法运行基线检查" >&2
  exit 1
fi

# 只检查工作区根：bun 会把依赖 hoist 到根，无依赖的包（如 packages/shared）
# 本来就不会有 node_modules —— 按包检查会在 fresh install / 新 worktree / CI 上误报。
if [ ! -d node_modules ]; then
  echo "❌ 找不到 node_modules（依赖未安装）" >&2
  echo "   先运行：bun install" >&2
  exit 1
fi

# ---- 执行 ------------------------------------------------------------------
FAILED_STEP=""
STEP_START=0

run_step() {
  local label="$1"
  shift
  STEP_START=$SECONDS
  printf '\n▶ %s\n' "$label"
  if "$@"; then
    printf '✅ %s (%ss)\n' "$label" "$((SECONDS - STEP_START))"
    return 0
  fi
  printf '❌ %s 失败 (%ss)\n' "$label" "$((SECONDS - STEP_START))" >&2
  FAILED_STEP="$label"
  return 1
}

TOTAL_START=$SECONDS
printf '▶ 基线检查开始（tree %s）\n' "${TREE_KEY:0:12}"

if ! run_step '全量 typecheck（bun run typecheck）' bun run typecheck; then
  printf '\n❌ 基线检查失败，失败步骤：%s\n' "$FAILED_STEP" >&2
  exit 1
fi

for p in "${PACKAGES[@]}"; do
  if ! run_step "测试 $p（cd $p && bun test）" bash -c "cd '$p' && bun test"; then
    printf '\n❌ 基线检查失败，失败步骤：%s\n' "$FAILED_STEP" >&2
    exit 1
  fi
done

# 只有全绿且缓存可用时才写
if [ "$CACHE_ENABLED" = "1" ]; then
  printf '%s\n' "$TREE_KEY" > "$CACHE_FILE"
fi

printf '\n✅ 基线检查通过（%ss，tree %s）\n' "$((SECONDS - TOTAL_START))" "${TREE_KEY:0:12}"
