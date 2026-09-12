#!/usr/bin/env bash
#
# 发布前检查（默认只读）—— 把「发布前容易漏的事」变成一条命令
#
# 检查项：
#   1. 工作区是否干净、是否有未完成的合并/rebase
#   2. 每个 worktree 的改动是否都已进入 main（未进 main 的会拦下来，让你先问用户是否要合并）
#   3. 本地分支：已合并进 main 的（可删除）与未合并的（需确认）
#   4. 版本号（apps/desktop/package.json 是唯一的版本来源）
#   5. 门禁是否装好（core.hooksPath=.githooks）
#   6. 与 origin 的差距（需要网络，--offline 跳过）
#
# 用法：
#   bash scripts/release-check.sh                 只检查（发布前跑这个）
#   bash scripts/release-check.sh --prune-merged  额外把「已完全合并进 main」的临时分支删掉
#   bash scripts/release-check.sh --offline       不访问远端
#
# 退出码：0 = 无阻塞项（可能有提示）；1 = 有阻塞项，先处理再发布
set -uo pipefail

PRUNE=0
OFFLINE=0
for arg in "$@"; do
  case "$arg" in
    --prune-merged) PRUNE=1 ;;
    --offline) OFFLINE=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数：$arg（可用：--prune-merged / --offline）" >&2; exit 2 ;;
  esac
done

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "release-check: 不在 git 仓库内" >&2
  exit 1
}
cd "$ROOT" || exit 1

# 长期分支：不参与清理，也不算「未合并」
BLOCKERS=0
is_protected() { case "$1" in main|dev) return 0 ;; *) return 1 ;; esac; }
blk() { BLOCKERS=$((BLOCKERS + 1)); printf '  ❌ %s\n' "$1"; }
warn() { printf '  ⚠️  %s\n' "$1"; }
ok() { printf '  ✅ %s\n' "$1"; }

printf '\n=== 发布前检查（%s）===\n' "$ROOT"

# ---- 1. 未完成的 git 操作 / 工作区状态 ------------------------------------
printf '\n[1] 仓库状态\n'
for f in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD; do
  if [ -f ".git/$f" ]; then blk "存在未完成的 git 操作：.git/$f（先完成或中止它）"; fi
done
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  blk "存在未完成的 rebase（先完成或中止它）"
fi
if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交改动（不会进入发布内容，但请确认不属于本次发布）："
  git status --porcelain | sed 's/^/       /' | head -10
else
  ok "工作区干净"
fi

# ---- 2. worktree -----------------------------------------------------------
printf '\n[2] worktree\n'
wt_count=0
while read -r key value; do
  case "$key" in
    worktree) WT_PATH="$value" ;;
    branch)
      wt_count=$((wt_count + 1))
      WT_BRANCH="${value#refs/heads/}"
      if is_protected "$WT_BRANCH"; then
        printf '  · %s → %s（长期分支，跳过）\n' "$WT_PATH" "$WT_BRANCH"
      elif git merge-base --is-ancestor "$WT_BRANCH" main 2>/dev/null; then
        ok "$WT_BRANCH 已在 main 中（%s）" "$WT_PATH"
      else
        blk "$WT_BRANCH 未合并进 main（worktree: $WT_PATH）—— 询问用户是否需要合并后再发布"
      fi
      ;;
    detached)
      wt_count=$((wt_count + 1))
      blk "$WT_PATH 处于 detached HEAD —— 确认它的改动是否已进入 main"
      ;;
  esac
done < <(git worktree list --porcelain)
[ "$wt_count" -eq 0 ] && warn "没有解析到 worktree（异常，请检查 git worktree list）"

# ---- 3. 本地分支 -----------------------------------------------------------
printf '\n[3] 本地分支\n'
MERGED_TMP=()
while IFS= read -r BR; do
  [ -n "$BR" ] || continue
  if is_protected "$BR"; then
    printf '  · %s（长期分支，保留）\n' "$BR"
  elif git merge-base --is-ancestor "$BR" main 2>/dev/null; then
    MERGED_TMP+=("$BR")
    printf '  · %s（已合并进 main，可删除）\n' "$BR"
  else
    blk "$BR 未合并进 main —— 询问用户是否需要合并后再发布"
  fi
done < <(git for-each-ref --format='%(refname:short)' refs/heads)

if [ "$PRUNE" = "1" ] && [ "${#MERGED_TMP[@]}" -gt 0 ]; then
  printf '  → --prune-merged：删除 %s\n' "${MERGED_TMP[*]}"
  for BR in "${MERGED_TMP[@]}"; do
    # 被任何 worktree 检出的分支不能删；git branch -d 本身也只会删除已合并的分支
    if git worktree list --porcelain | grep -q "^branch refs/heads/$BR$"; then
      warn "$BR 正被某个 worktree 检出，跳过"
    elif git branch -d "$BR" >/dev/null 2>&1; then
      ok "已删除 $BR"
    else
      warn "$BR 删除失败（可能未完全合并），请手动确认"
    fi
  done
elif [ "${#MERGED_TMP[@]}" -gt 0 ]; then
  printf '  （要清理这些分支：bash scripts/release-check.sh --prune-merged）\n'
fi

# ---- 4. 版本号 -------------------------------------------------------------
printf '\n[4] 版本号\n'
VERSION_FILE="apps/desktop/package.json"
WORKTREE_VERSION="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$VERSION_FILE" | head -1)"
MAIN_VERSION="$(git show "main:$VERSION_FILE" 2>/dev/null | sed -n 's/.*"version": "\([^"]*\)".*/\1/p' | head -1)"
printf '  · 工作区 %s = %s\n' "$VERSION_FILE" "${WORKTREE_VERSION:-<读取失败>}"
printf '  · main 上 = %s\n' "${MAIN_VERSION:-<读取失败>}"
if [ -n "$MAIN_VERSION" ] && [ "$WORKTREE_VERSION" = "$MAIN_VERSION" ]; then
  warn "工作区与 main 版本相同 —— 如果这次要发新版本，先在 dev 上 bump"
else
  ok "版本号与 main 不同，看起来是本轮待发布的版本"
fi

# ---- 5. 门禁 ---------------------------------------------------------------
printf '\n[5] 门禁\n'
if [ "$(git config --get core.hooksPath 2>/dev/null)" = ".githooks" ]; then
  ok "core.hooksPath=.githooks（合并/推送 main 会跑基线）"
else
  warn "hooks 未安装或 hooksPath 不指向 .githooks —— 运行 bash scripts/setup-hooks.sh"
fi
MISSING_HOOKS=0
for h in pre-merge-commit pre-push; do
  [ -x ".githooks/$h" ] || { MISSING_HOOKS=1; warn ".githooks/$h 缺失或不可执行"; }
done
[ "$MISSING_HOOKS" = "0" ] && ok "pre-merge-commit / pre-push 可执行"

# ---- 6. 与 origin 的差距 ---------------------------------------------------
printf '\n[6] 远端（origin）\n'
if [ "$OFFLINE" = "1" ]; then
  warn "--offline：跳过远端检查"
else
  REMOTE="$(GIT_TERMINAL_PROMPT=0 timeout 25 git ls-remote --heads origin refs/heads/main refs/heads/dev 2>/dev/null)"
  if [ -z "$REMOTE" ]; then
    warn "无法读取 origin（网络/权限）—— 推送时若失败就跳过，不影响本地发布"
  else
    for BR in main dev; do
      R_SHA="$(printf '%s\n' "$REMOTE" | awk -v r="refs/heads/$BR" '$2 == r { print $1 }')"
      [ -n "$R_SHA" ] || { warn "origin 上没有 $BR"; continue; }
      LOCAL_SHA="$(git rev-parse "$BR")"
      if [ "$R_SHA" = "$LOCAL_SHA" ]; then
        ok "$BR 与 origin 一致"
      elif git merge-base --is-ancestor "$R_SHA" "$LOCAL_SHA" 2>/dev/null; then
        printf '  · %s 领先 origin %s 个提交（待 push）\n' "$BR" "$(git rev-list --count "$R_SHA..$LOCAL_SHA")"
      else
        blk "$BR 与 origin 分叉（origin 有本地没有的提交）—— 先 fetch/rebase，不要强推"
      fi
    done
  fi
fi

# ---- 结果 ------------------------------------------------------------------
printf '\n=== 结果：'
if [ "$BLOCKERS" -gt 0 ]; then
  printf '%s 个阻塞项，先处理再发布 ===\n\n' "$BLOCKERS"
  exit 1
fi
cat <<'NEXT'
无阻塞项 ===

后续（发布步骤，见 docs/release-process.md）：
  1) 在 dev 上 bump 版本：apps/desktop/package.json（唯一的版本来源），提交
  2) git checkout main && git merge --no-ff dev -m "merge: release vX.Y.Z from dev"   # 门禁跑全量基线
  3) git push origin dev && git push origin main                                    # 无权限就跳过
  4) git tag vX.Y.Z <merge-commit> && git push origin vX.Y.Z                        # 触发 Release 构建
NEXT
