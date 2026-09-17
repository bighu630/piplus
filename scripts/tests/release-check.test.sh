#!/usr/bin/env bash
#
# release-check.sh 自测：在临时仓库里验证「拦住未合并的 worktree/分支」「清理已合并分支」等行为。
# 这个脚本会删分支，所以清理逻辑必须有测试兜底。
#
# 用法：bash scripts/tests/release-check.test.sh
set -uo pipefail

REAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
KEEP="${RELEASE_TEST_KEEP:-0}"
cleanup() {
  if [ "$KEEP" = "1" ] && [ "${FAIL:-0}" != "0" ]; then
    printf '\n（RELEASE_TEST_KEEP=1）临时目录保留在：%s\n' "$WORK"
    return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

export GIT_AUTHOR_NAME=release-test GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=release-test GIT_COMMITTER_EMAIL=t@example.invalid

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ❌ %s\n' "$1"; }
assert_exit() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1（exit=$3）"; else bad "$1：期望 exit=$2，实际 $3"; fi
}
assert_contains() { # desc needle haystack
  case "$3" in
    *"$2"*) ok "$1" ;;
    *) bad "$1：输出中找不到 [$2]" ;;
  esac
}
assert_branch_exists() { # desc repo branch
  if ( cd "$2" && git rev-parse --verify -q "refs/heads/$3" >/dev/null ); then ok "$1"; else bad "$1：分支 $3 不存在"; fi
}
assert_branch_absent() { # desc repo branch
  if ( cd "$2" && git rev-parse --verify -q "refs/heads/$3" >/dev/null ); then bad "$1：分支 $3 仍存在"; else ok "$1"; fi
}

# 建一个最小可用的仓库：main/dev + 版本文件 + 脚本副本
make_repo() { # $1 = name -> 打印路径
  local d="$WORK/$1"
  mkdir -p "$d/scripts" "$d/apps/desktop"
  cp "$REAL_ROOT/scripts/release-check.sh" "$d/scripts/release-check.sh"
  chmod +x "$d/scripts/release-check.sh"
  printf '{\n  "name": "piplus",\n  "version": "0.3.0"\n}\n' >"$d/apps/desktop/package.json"
  (
    cd "$d" || exit 1
    git init -q -b main .
    git add -A >/dev/null 2>&1
    git commit -qm "chore: init" >/dev/null 2>&1
    git checkout -qb dev
    git checkout -q main
  ) >/dev/null 2>&1
  printf '%s\n' "$d"
}

run_check() { # $repo [args...] -> 打印 exit code
  local d="$1"
  shift
  ( cd "$d" && bash scripts/release-check.sh --offline "$@" ) >"$d/out.txt" 2>&1
  echo $?
}

section() { printf '\n=== %s ===\n' "$1"; }

# ---------------------------------------------------------------------------
section "A: 干净仓库（只有 main/dev）"

A="$(make_repo repo-a)"
rc="$(run_check "$A")"
assert_exit "A1 无阻塞项" 0 "$rc"
assert_contains "A1 长期分支被识别为保留" "长期分支，保留" "$(cat "$A/out.txt")"

# ---------------------------------------------------------------------------
section "B: 已合并的临时分支（可清理）"

B="$(make_repo repo-b)"
( cd "$B" && git checkout -qb feature/merged && echo x >x.txt && git add -A && git commit -qm "merged work" && git checkout -q dev && git merge -q --no-ff feature/merged -m "merge feature" && git checkout -q main && git merge -q --no-ff dev -m "release" ) >/dev/null 2>&1

rc="$(run_check "$B")"
assert_exit "B1 已合并的临时分支不算阻塞" 0 "$rc"
assert_contains "B1 提示已合并可删除" "已合并进 main，可删除" "$(cat "$B/out.txt")"
assert_branch_exists "B1 不加 --prune-merged 时不删分支" "$B" "feature/merged"

rc="$(run_check "$B" --prune-merged)"
assert_exit "B2 --prune-merged 执行成功" 0 "$rc"
assert_branch_absent "B2 删除已合并的临时分支" "$B" "feature/merged"
assert_branch_exists "B2 保留 main" "$B" "main"
assert_branch_exists "B2 保留 dev" "$B" "dev"

# ---------------------------------------------------------------------------
section "C: 未合并的分支（阻塞，需问用户）"

C="$(make_repo repo-c)"
( cd "$C" && git checkout -qb feature/unmerged && echo y >y.txt && git add -A && git commit -qm "unmerged work" && git checkout -q dev ) >/dev/null 2>&1

rc="$(run_check "$C")"
assert_exit "C1 未合并分支 → 阻塞（exit 1）" 1 "$rc"
assert_contains "C1 提示询问用户" "询问用户是否需要合并" "$(cat "$C/out.txt")"

rc="$(run_check "$C" --prune-merged)"
assert_branch_exists "C2 --prune-merged 不碰未合并分支" "$C" "feature/unmerged"

# ---------------------------------------------------------------------------
section "D: 未合并的 worktree（阻塞）"

D="$(make_repo repo-d)"
( cd "$D" && git checkout -qb feature/wt && echo z >z.txt && git add -A && git commit -qm "wt work" && git checkout -q dev && git worktree add -q ../repo-d-wt feature/wt ) >/dev/null 2>&1

rc="$(run_check "$D")"
assert_exit "D1 未合并的 worktree → 阻塞" 1 "$rc"
assert_contains "D1 指出是哪个分支" "feature/wt 未合并进 main" "$(cat "$D/out.txt")"

# 合并该分支后应放行（worktree 仍在，但分支已进 main）
( cd "$D" && git merge -q --no-ff feature/wt -m "merge wt" && git checkout -q main && git merge -q --no-ff dev -m "release" ) >/dev/null 2>&1
rc="$(run_check "$D")"
assert_exit "D2 分支合并进 main 后放行" 0 "$rc"
assert_contains "D2 worktree 分支被识别为已合并" "已在 main 中" "$(cat "$D/out.txt")"

# ---------------------------------------------------------------------------
section "E: 版本号识别"

E="$(make_repo repo-e)"
(
  cd "$E" && git checkout -q dev
  printf '{\n  "name": "piplus",\n  "version": "0.4.0"\n}\n' >apps/desktop/package.json
  git add -A && git commit -qm "chore: bump version to v0.4.0"
) >/dev/null 2>&1
rc="$(run_check "$E")"
assert_exit "E1 无阻塞" 0 "$rc"
assert_contains "E1 识别工作区版本" "工作区 apps/desktop/package.json = 0.4.0" "$(cat "$E/out.txt")"
assert_contains "E1 识别 main 版本" "main 上 = 0.3.0" "$(cat "$E/out.txt")"
assert_contains "E1 提示是本轮待发布版本" "待发布的版本" "$(cat "$E/out.txt")"

# ---------------------------------------------------------------------------
printf '\n========================================\n'
printf '通过 %s 项，失败 %s 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '❌ release-check 自测失败\n'
  exit 1
fi
printf '✅ release-check 自测全部通过\n'
