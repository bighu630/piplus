#!/usr/bin/env bash
#
# 门禁自测：在临时仓库里验证 .githooks/* 与 scripts/baseline-check.sh 的真实行为。
#
# hook 最危险的失效方式是"静默地不再触发"（守卫写错、路径变化、权限丢失），
# 看起来一切正常但门禁已经不存在了 —— 所以门禁本身必须有自测。
#
# 全部在 mktemp -d 下进行，不触碰当前仓库；真实基线（约 107s）不会被执行：
#   - group A 用假 bun + 假 node_modules 测 baseline-check.sh 的逻辑（缓存/跳过/前置检查）
#   - group B 用 stub baseline-check.sh 测 hook 的守卫与拦截（hook 用的是仓库里的真文件）
#
# 用法：
#   bash scripts/tests/baseline-gate.test.sh
#   BASELINE_TEST_KEEP=1 bash scripts/tests/baseline-gate.test.sh   # 保留临时目录便于排查
set -uo pipefail

REAL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
KEEP="${BASELINE_TEST_KEEP:-0}"
cleanup() {
  if [ "$KEEP" = "1" ] && [ "${FAIL:-0}" != "0" ]; then
    printf '\n（BASELINE_TEST_KEEP=1）临时目录保留在：%s\n' "$WORK"
    return
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

# scratch 仓库里提交需要身份
export GIT_AUTHOR_NAME=baseline-test GIT_AUTHOR_EMAIL=t@example.invalid
export GIT_COMMITTER_NAME=baseline-test GIT_COMMITTER_EMAIL=t@example.invalid

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ✅ %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  ❌ %s\n' "$1"; }

assert_exit_zero() { # desc actual
  if [ "$2" = "0" ]; then ok "$1（exit=0）"; else bad "$1：期望 exit=0，实际 $2"; fi
}
assert_exit_nonzero() { # desc actual
  if [ "$2" != "0" ]; then ok "$1（exit=$2）"; else bad "$1：期望非 0，实际 0"; fi
}
assert_eq() { # desc expected actual
  if [ "$2" = "$3" ]; then ok "$1（=$3）"; else bad "$1：期望 [$2]，实际 [$3]"; fi
}
assert_contains() { # desc needle haystack
  case "$3" in
    *"$2"*) ok "$1" ;;
    *) bad "$1：输出中找不到 [$2]" ;;
  esac
}
assert_file_exists() { # desc path
  if [ -f "$2" ]; then ok "$1"; else bad "$1：文件不存在 $2"; fi
}
assert_file_absent() { # desc path
  if [ -f "$2" ]; then bad "$1：文件意外存在 $2"; else ok "$1"; fi
}

section() { printf '\n=== %s ===\n' "$1"; }
commit() { ( cd "$1" && git add -A >/dev/null 2>&1 && git commit -qm "$2" ) >/dev/null 2>&1; }
sha() { ( cd "$1" && git rev-parse HEAD ); }

# 构造一个 scratch 仓库：真 hooks + stub 基线脚本。
# stub 通过 STUB_INVOCATIONS 计数，并用 BASELINE_TEST_STUB_FAIL=1 模拟基线失败。
init_repo() { # $1 = 目录名 -> 打印路径
  local d="$WORK/$1"
  mkdir -p "$d/scripts"
  ( cd "$d" && git init -q -b main . ) >/dev/null 2>&1
  cp -r "$REAL_ROOT/.githooks" "$d/.githooks"
  chmod +x "$d/.githooks"/* 2>/dev/null
  ( cd "$d" && git config --local core.hooksPath .githooks ) >/dev/null 2>&1
  cat >"$d/scripts/baseline-check.sh" <<STUB
#!/usr/bin/env bash
echo "invoked" >>"\$STUB_INVOCATIONS"
[ "\${BASELINE_TEST_STUB_FAIL:-0}" = "1" ] && { echo "STUB: baseline FAILED"; exit 1; }
echo "STUB: baseline passed"
exit 0
STUB
  chmod +x "$d/scripts/baseline-check.sh"
  printf '%s\n' "$d"
}

LOGS="$WORK/logs"
mkdir -p "$LOGS"

STUB_INVOCATIONS="$WORK/stub-invocations"
export STUB_INVOCATIONS
: >"$STUB_INVOCATIONS"
stub_calls() { wc -l <"$STUB_INVOCATIONS" | tr -d ' '; }

# ---------------------------------------------------------------------------
section "group A: scripts/baseline-check.sh 逻辑（假 bun，不跑真实测试）"

FAKEBIN="$WORK/bin"
mkdir -p "$FAKEBIN"
cat >"$FAKEBIN/bun" <<'FAKEBUN'
#!/usr/bin/env bash
# 记录被调用时的 GIT_* 变量个数，用来断言 baseline-check.sh 已清理 hook 泄漏的环境
{ echo "FAKE-BUN $* git_env=$(env | grep -c '^GIT')"; } >>"${FAKE_BUN_LOG:-/dev/null}"
[ "${FAKE_BUN_EXIT:-0}" = "0" ] || exit "${FAKE_BUN_EXIT}"
exit 0
FAKEBUN
chmod +x "$FAKEBIN/bun"

A_REPO="$WORK/repo-a"
mkdir -p "$A_REPO/scripts" "$A_REPO/src"
cp "$REAL_ROOT/scripts/baseline-check.sh" "$A_REPO/scripts/baseline-check.sh"
printf 'tracked\n' >"$A_REPO/tracked.txt"   # A8 需要一个受版本控制的文件来制造未 staged 改动
for p in . apps/api apps/web packages/db packages/domain packages/pi-client packages/shared; do
  mkdir -p "$A_REPO/$p/node_modules"
done
( cd "$A_REPO" && git init -q -b main . && git add -A >/dev/null 2>&1 && git commit -qm init ) >/dev/null 2>&1

CACHE="$A_REPO/.git/baseline-passed-tree"
OUT="$LOGS/a.txt"

run_check() { # [NAME=VALUE ...] -> 打印 exit code
  (
    cd "$A_REPO" || exit 1
    env PATH="$FAKEBIN:$PATH" FAKE_BUN_LOG="$A_REPO/bun.log" "$@" bash scripts/baseline-check.sh
  ) >"$OUT" 2>&1
  echo $?
}
bun_calls() { if [ -f "$A_REPO/bun.log" ]; then wc -l <"$A_REPO/bun.log" | tr -d ' '; else echo 0; fi; }

rc="$(run_check)"
assert_exit_zero "A1 首次全绿通过" "$rc"
assert_eq "A1 typecheck + 6 包测试 = 7 次 bun 调用" "7" "$(bun_calls)"
assert_file_exists "A1 写入通过缓存" "$CACHE"

calls_before="$(bun_calls)"
rc="$(run_check)"
assert_exit_zero "A2 第二次运行" "$rc"
assert_contains "A2 命中缓存" "缓存命中" "$(cat "$OUT")"
assert_eq "A2 命中缓存时不执行任何命令" "$calls_before" "$(bun_calls)"

rc="$(run_check BASELINE_NO_CACHE=1)"
assert_exit_zero "A3 BASELINE_NO_CACHE=1 强制实跑" "$rc"
assert_eq "A3 强制实跑再调用 7 次" "7" "$(( $(bun_calls) - calls_before ))"

rm -f "$CACHE"
rc="$(run_check BASELINE_NO_CACHE=1 FAKE_BUN_EXIT=1)"
assert_exit_nonzero "A4 失败时返回非 0" "$rc"
assert_contains "A4 报告失败" "基线检查失败" "$(cat "$OUT")"
assert_file_absent "A4 失败不写缓存" "$CACHE"

calls_before="$(bun_calls)"
rc="$(run_check BASELINE_SKIP=1)"
assert_exit_zero "A5 BASELINE_SKIP=1 直接放行" "$rc"
assert_eq "A5 跳过时零调用" "$calls_before" "$(bun_calls)"

# A6：某个包没有自己的 node_modules 不算缺依赖（fresh install 下 packages/shared 就没有：
# 无依赖的包不会有 node_modules，依赖都 hoist 到根）—— 这正是 CI / 新 worktree 的真实情况。
mv "$A_REPO/packages/db/node_modules" "$A_REPO/packages/db/node_modules.off"
rc="$(run_check BASELINE_NO_CACHE=1)"
assert_exit_zero "A6 包内缺 node_modules 不算缺依赖（依赖 hoist 到根）" "$rc"
mv "$A_REPO/packages/db/node_modules.off" "$A_REPO/packages/db/node_modules"

# A7：根 node_modules 缺失才算依赖未安装
mv "$A_REPO/node_modules" "$A_REPO/node_modules.off"
rc="$(run_check BASELINE_NO_CACHE=1)"
assert_exit_nonzero "A7 缺根 node_modules 时失败" "$rc"
assert_contains "A7 提示 bun install" "bun install" "$(cat "$OUT")"
mv "$A_REPO/node_modules.off" "$A_REPO/node_modules"

# A9：git hook 导出的 GIT_DIR / GIT_INDEX_FILE 不得污染基线。
# 回归背景：linked worktree 里跑 pre-merge-commit 时，git 会把 GIT_DIR 导成绝对路径，
# 优先级高于 `git -C`，导致 apps/api 里用 fixture 的 git 用例全部假失败（真实发布被拦）。
rc="$(run_check BASELINE_NO_CACHE=1 GIT_DIR=/nonexistent GIT_INDEX_FILE=/nonexistent/index)"
assert_exit_zero "A9 忽略调用方泄漏的 GIT_DIR/GIT_INDEX_FILE" "$rc"
assert_contains "A9 仍然完成全量检查" "基线检查通过" "$(cat "$OUT")"

# A10：hook 泄漏的任意 GIT_* 变量都必须被清掉（不只 GIT_DIR）。
# 背景：GIT_REFLOG_ACTION 会改写 reflog 消息，使 git 在 detached HEAD 下不再输出
# "(HEAD detached at ...)"（变成 "(no branch)"），直接打挂 apps/api 的 sanity 断言 ——
# 真实发布合并被它拦了第二次。这里直接断言子进程环境里没有残留 GIT_*。
rm -f "$A_REPO/bun.log"
rc="$(run_check BASELINE_NO_CACHE=1 GIT_REFLOG_ACTION="merge dev" GITHEAD_deadbeef=dev GIT_EDITOR=: GIT_DIR=/nonexistent)"
assert_exit_zero "A10 带任意 GIT_* 污染仍能跑完基线" "$rc"
assert_eq "A10 子进程环境里没有残留 GIT_* 变量" "0" "$(grep -c 'git_env=[1-9]' "$A_REPO/bun.log" 2>/dev/null || true)"

# A8：工作区有未 staged 改动时，被测内容 ≠ index tree，必须禁用缓存（否则会误标已通过）
rm -f "$CACHE"
rc="$(run_check)"
assert_exit_zero "A8 干净工作区写入缓存" "$rc"
assert_file_exists "A8 缓存已写入" "$CACHE"
calls_before="$(bun_calls)"
echo "unstaged edit" >>"$A_REPO/tracked.txt"
rc="$(run_check)"
assert_exit_zero "A8 脏工作区仍能跑完" "$rc"
assert_contains "A8 提示不使用缓存" "不使用缓存" "$(cat "$OUT")"
assert_eq "A8 脏工作区不被缓存短路（真的跑了 7 次）" "$(( calls_before + 7 ))" "$(bun_calls)"
( cd "$A_REPO" && git checkout -- tracked.txt ) >/dev/null 2>&1
rc="$(run_check)"
assert_contains "A8 恢复干净后缓存又生效" "缓存命中" "$(cat "$OUT")"

# ---------------------------------------------------------------------------
section "group B: pre-merge-commit（拦截 + 守卫）"

B="$(init_repo repo-b)"
echo base >"$B/base.txt"
commit "$B" base
( cd "$B" && git checkout -qb feature && echo feat >"$B/feat.txt" ) >/dev/null 2>&1
commit "$B" "feature work"
( cd "$B" && git checkout -q main ) >/dev/null 2>&1
MAIN_SHA="$(sha "$B")"   # 合并前 main 的 sha（在 feature 上取会拿到 feature 的 sha）

( cd "$B" && BASELINE_TEST_STUB_FAIL=1 git merge feature --no-ff --no-edit ) >"$LOGS/b.txt" 2>&1
assert_exit_nonzero "B1 main 上非 FF 合并 + 基线失败 → 被拦" "$?"
assert_eq "B1 未生成 merge commit（HEAD 不变）" "$MAIN_SHA" "$(sha "$B")"
assert_eq "B1 merge 留在进行中状态" "1" "$( cd "$B" && git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && echo 1 || echo 0 )"
assert_contains "B1 提示 git merge --abort" "git merge --abort" "$(cat "$LOGS/b.txt")"

( cd "$B" && git merge --abort ) >/dev/null 2>&1
assert_exit_zero "B2 --abort 成功" "$?"
assert_eq "B2 --abort 后 HEAD 回到合并前" "$MAIN_SHA" "$(sha "$B")"
assert_eq "B2 --abort 后 merge 状态被清掉" "0" "$( cd "$B" && git rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 && echo 1 || echo 0 )"
assert_eq "B2 --abort 后合并内容已回退（feat.txt 不存在）" "0" "$( [ -f "$B/feat.txt" ] && echo 1 || echo 0 )"

( cd "$B" && git merge feature --no-ff --no-edit ) >"$LOGS/b.txt" 2>&1
assert_exit_zero "B3 基线通过 → 合并放行" "$?"
assert_eq "B3 生成 merge commit（2 个父提交）" "3" "$( cd "$B" && git rev-list --parents -n1 HEAD | wc -w | tr -d ' ' )"

calls_before="$(stub_calls)"
# 前置：stub 计数器必须真的在工作（B1/B3 已调用过），否则下面的"未增加"断言是空洞的
if [ "$calls_before" -gt 0 ]; then ok "B4 前置：stub 计数器有效（已调用 $calls_before 次）"; else bad "B4 前置：stub 计数器为 0，断言将失去意义"; fi
( cd "$B" && git checkout -qb work2 && echo x >"$B/x.txt" ) >/dev/null 2>&1
commit "$B" "work2"
# 让 main 领先一步，否则 work2 合并 main 是 "Already up to date"（测不到守卫）
( cd "$B" && git checkout -q main && echo m2 >"$B/m2.txt" ) >/dev/null 2>&1
commit "$B" "main moves on"
( cd "$B" && git checkout -q work2 ) >/dev/null 2>&1
( cd "$B" && BASELINE_TEST_STUB_FAIL=1 git merge main --no-ff --no-edit ) >"$LOGS/b.txt" 2>&1
assert_exit_zero "B4 feature 分支合并 main → 放行" "$?"
assert_eq "B4 守卫生效，未调用基线脚本" "$calls_before" "$(stub_calls)"
assert_eq "B4 确实生成了 merge commit" "3" "$( cd "$B" && git rev-list --parents -n1 HEAD | wc -w | tr -d ' ' )"

( cd "$B" && git checkout -q main && git checkout -qb ff-src && echo y >"$B/y.txt" ) >/dev/null 2>&1
commit "$B" "ff src"
( cd "$B" && git checkout -q main && BASELINE_TEST_STUB_FAIL=1 git merge ff-src ) >"$LOGS/b.txt" 2>&1
assert_exit_zero "B5 FF 合并是已知盲区（由 pre-push 兜底）" "$?"

# ---------------------------------------------------------------------------
section "group C: pre-push（只拦 main）"

P="$(init_repo repo-p)"
git init -q --bare "$WORK/remote.git" >/dev/null 2>&1
( cd "$P" && git remote add origin "$WORK/remote.git" ) >/dev/null 2>&1
echo base >"$P/base.txt"
commit "$P" base
( cd "$P" && git push -q origin main ) >"$LOGS/c.txt" 2>&1
assert_exit_zero "C1 首次 push main（基线通过）放行" "$?"
REMOTE_MAIN="$( cd "$WORK/remote.git" && git rev-parse refs/heads/main )"

( cd "$P" && git checkout -qb dev && echo d >"$P/d.txt" ) >/dev/null 2>&1
commit "$P" "dev work"
# 关键：回到 main 再 squash（否则 squash 落在 dev 上，后面 push main 变成空操作）
( cd "$P" && git checkout -q main ) >/dev/null 2>&1
assert_eq "C2 前置：已在 main 上" "main" "$( cd "$P" && git rev-parse --abbrev-ref HEAD )"
( cd "$P" && BASELINE_TEST_STUB_FAIL=1 git merge --squash dev && BASELINE_TEST_STUB_FAIL=1 git commit -qm squashed ) >"$LOGS/c.txt" 2>&1
assert_exit_zero "C2 squash 合并本身不被 pre-merge-commit 拦（盲区）" "$?"
assert_eq "C2 squash 提交落在 main 上且领先远端" "1" "$([ "$(sha "$P")" != "$REMOTE_MAIN" ] && echo 1 || echo 0)"

( cd "$P" && BASELINE_TEST_STUB_FAIL=1 git push origin main ) >"$LOGS/c.txt" 2>&1
assert_exit_nonzero "C3 squash 后 push main + 基线失败 → 被拦" "$?"
assert_eq "C3 远端 main 未推进" "$REMOTE_MAIN" "$( cd "$WORK/remote.git" && git rev-parse refs/heads/main )"
assert_contains "C3 给出绕过提示" "--no-verify" "$(cat "$LOGS/c.txt")"

( cd "$P" && BASELINE_TEST_STUB_FAIL=1 git push -q origin dev ) >"$LOGS/c.txt" 2>&1
assert_exit_zero "C4 push 到 dev（基线失败）→ 放行" "$?"

( cd "$P" && git push -q origin main ) >"$LOGS/c.txt" 2>&1
assert_exit_zero "C5 push main + 基线通过 → 放行" "$?"
assert_eq "C5 远端 main 已推进" "$(sha "$P")" "$( cd "$WORK/remote.git" && git rev-parse refs/heads/main )"

echo z >"$P/z.txt"
commit "$P" bypass
( cd "$P" && BASELINE_TEST_STUB_FAIL=1 git push -q --no-verify origin main ) >"$LOGS/c.txt" 2>&1
assert_exit_zero "C6 --no-verify 可应急绕过" "$?"
assert_eq "C6 绕过确实推送成功" "$(sha "$P")" "$( cd "$WORK/remote.git" && git rev-parse refs/heads/main )"

# ---------------------------------------------------------------------------
section "group E: 端到端 —— 门禁合并 + 缓存让双闸不跑两遍（真 hooks + 真 baseline-check + 假 bun）"

E="$WORK/repo-e"
mkdir -p "$E/scripts"
( cd "$E" && git init -q -b main . ) >/dev/null 2>&1
cp -r "$REAL_ROOT/.githooks" "$E/.githooks"
chmod +x "$E/.githooks"/* 2>/dev/null
( cd "$E" && git config --local core.hooksPath .githooks ) >/dev/null 2>&1
cp "$REAL_ROOT/scripts/baseline-check.sh" "$E/scripts/baseline-check.sh"
for p in . apps/api apps/web packages/db packages/domain packages/pi-client packages/shared; do
  mkdir -p "$E/$p/node_modules"
done

E_LOG="$LOGS/e-bun.log"
: >"$E_LOG"
E_CACHE="$E/.git/baseline-passed-tree"

echo base >"$E/base.txt"
commit "$E" base
( cd "$E" && git checkout -qb feature && echo f >"$E/f.txt" ) >/dev/null 2>&1
commit "$E" feat
( cd "$E" && git checkout -q main ) >/dev/null 2>&1

( cd "$E" && PATH="$FAKEBIN:$PATH" FAKE_BUN_LOG="$E_LOG" git merge feature --no-ff --no-edit ) >"$LOGS/e1.txt" 2>&1
assert_exit_zero "E1 门禁合并（基线通过）→ 放行" "$?"
assert_eq "E1 确实生成了 merge commit" "3" "$( cd "$E" && git rev-list --parents -n1 HEAD | wc -w | tr -d ' ' )"
assert_file_exists "E1 门禁运行后写入通过缓存" "$E_CACHE"
E_CALLS="$(wc -l <"$E_LOG" | tr -d ' ')"
assert_eq "E1 基线实跑 7 次 bun（typecheck + 6 包）" "7" "$E_CALLS"

git init -q --bare "$WORK/remote-e.git" >/dev/null 2>&1
( cd "$E" && git remote add origin "$WORK/remote-e.git" ) >/dev/null 2>&1
( cd "$E" && PATH="$FAKEBIN:$PATH" FAKE_BUN_LOG="$E_LOG" git push -q origin main ) >"$LOGS/e2.txt" 2>&1
assert_exit_zero "E2 push main（同棵树）→ 放行" "$?"
assert_contains "E2 走缓存而非重跑" "缓存命中" "$(cat "$LOGS/e2.txt")"
assert_eq "E2 双闸只跑一遍基线（bun 调用数不变）" "$E_CALLS" "$(wc -l <"$E_LOG" | tr -d ' ')"
assert_eq "E2 远端 main 已推进" "$(sha "$E")" "$( cd "$WORK/remote-e.git" && git rev-parse refs/heads/main )"

# E3：未被门禁验证过的新提交（基线失败）在 push 时被拦
( cd "$E" && echo bad >"$E/bad.txt" ) >/dev/null 2>&1
commit "$E" "unverified change"
( cd "$E" && PATH="$FAKEBIN:$PATH" FAKE_BUN_LOG="$E_LOG" FAKE_BUN_EXIT=1 git push origin main ) >"$LOGS/e3.txt" 2>&1
assert_exit_nonzero "E3 新提交 + 基线失败 → push 被拦" "$?"

# ---------------------------------------------------------------------------
section "group D: scripts/setup-hooks.sh（在 scratch 仓库里测真实逻辑）"

D_REPO="$(init_repo repo-d)"
( cd "$D_REPO" && git config --local --unset core.hooksPath ) >/dev/null 2>&1

( cd "$D_REPO" && bash "$REAL_ROOT/scripts/setup-hooks.sh" --check ) >"$LOGS/d.txt" 2>&1
assert_exit_nonzero "D1 未安装时 --check 返回非 0" "$?"
assert_eq "D1 --check 不修改配置" "" "$( cd "$D_REPO" && git config --local --get core.hooksPath 2>/dev/null )"

( cd "$D_REPO" && bash "$REAL_ROOT/scripts/setup-hooks.sh" ) >"$LOGS/d.txt" 2>&1
assert_exit_zero "D2 安装成功" "$?"
assert_eq "D2 core.hooksPath 已设为 .githooks" ".githooks" "$( cd "$D_REPO" && git config --local --get core.hooksPath )"

( cd "$D_REPO" && bash "$REAL_ROOT/scripts/setup-hooks.sh" --check ) >/dev/null 2>&1
assert_exit_zero "D3 安装后 --check 通过" "$?"

( cd "$D_REPO" && bash "$REAL_ROOT/scripts/setup-hooks.sh" ) >/dev/null 2>&1
assert_exit_zero "D4 幂等：重复安装不报错" "$?"

( cd "$D_REPO" && git config --local core.hooksPath .other-hooks )
( cd "$D_REPO" && bash "$REAL_ROOT/scripts/setup-hooks.sh" ) >"$LOGS/d.txt" 2>&1
assert_exit_nonzero "D5 已有其他 hooksPath 时拒绝覆盖" "$?"
assert_eq "D5 未篡改现有配置" ".other-hooks" "$( cd "$D_REPO" && git config --local --get core.hooksPath )"

( cd "$D_REPO" && bash "$REAL_ROOT/scripts/setup-hooks.sh" --force ) >/dev/null 2>&1
assert_exit_zero "D6 --force 可覆盖" "$?"
assert_eq "D6 已覆盖为 .githooks" ".githooks" "$( cd "$D_REPO" && git config --local --get core.hooksPath )"

for h in pre-merge-commit pre-push; do
  if [ -x "$REAL_ROOT/.githooks/$h" ]; then ok "D7 $h 存在且可执行"; else bad "D7 $h 缺失或不可执行"; fi
done

# ---------------------------------------------------------------------------
printf '\n========================================\n'
printf '通过 %s 项，失败 %s 项\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  printf '❌ 门禁自测失败\n'
  exit 1
fi
printf '✅ 门禁自测全部通过\n'
