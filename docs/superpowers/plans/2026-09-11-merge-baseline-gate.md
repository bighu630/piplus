# Merge 基线门禁 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 agent 停止运行全局 test/typecheck（AGENTS.md 声明纪律），并在合并/推送到 main 时由 hook + CI 自动执行同一份基线检查。

**Architecture:** `scripts/baseline-check.sh` 是基线的唯一真相源（全量 typecheck + 6 包逐包测试 + tree 缓存），被两个 git hook（`pre-merge-commit` 拦本地非 FF 合并、`pre-push` 拦任何推送到 main，覆盖 FF/squash）和 GitHub Actions workflow 共用。hook 通过仓库级 `core.hooksPath=.githooks` 生效，由 `bun install` 的 `prepare` 自动接线。

**Tech Stack:** bash、git hooks、GitHub Actions（`oven-sh/setup-bun@v2`）、bun 1.4.0。

**依据：** `docs/superpowers/specs/2026-09-11-merge-baseline-gate-design.md`（含实测数据与 hook 语义验证结果）

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `scripts/baseline-check.sh`（新建） | 基线唯一真相源：前置检查、tree 缓存、typecheck、逐包测试、汇总退出 |
| `.githooks/pre-merge-commit`（新建） | 仅拦"在 main 上做非 FF 合并"，失败给 `git merge --abort` 指引 |
| `.githooks/pre-push`（新建） | 仅拦"推送到 `refs/heads/main`"，先读净 stdin |
| `scripts/setup-hooks.sh`（新建） | 幂等安装 hooksPath，`--check` 模式，非本仓库 hooksPath 需 `--force` |
| `.github/workflows/baseline.yml`（新建） | `push`/`pull_request` → main，跑同一个脚本 |
| `package.json`（修改） | 新增 `"prepare": "bash scripts/setup-hooks.sh"` |
| `AGENTS.md`（新建） | 纪律、scoped 检查清单、速查表 |
| `scripts/tests/baseline-gate.test.sh`（新建） | scratch 仓库自测门禁行为（不触碰本仓库） |

依赖方向：hooks/workflow → `baseline-check.sh`；`prepare` → `setup-hooks.sh` → `.githooks/*`。低层无反向依赖。

---

### Task 1: baseline-check.sh

**Files:** Create: `scripts/baseline-check.sh`

- [x] 写脚本：`set -uo pipefail`（不用 `-e`，显式判错）；`git rev-parse --show-toplevel` 定位根并 `cd`；`PACKAGES=(apps/api apps/web packages/db packages/domain packages/pi-client packages/shared)`
- [x] 实现 `resolve_tree_key()`：`$BASELINE_TREE_KEY` → `git write-tree` → `git rev-parse 'HEAD^{tree}'` → `unknown`（顺序不可换，见 spec"tree 缓存"理由）
- [x] 缓存文件 `<git-common-dir>/baseline-passed-tree`；`--git-common-dir` 返回相对路径时拼 `$ROOT`
- [x] `BASELINE_SKIP=1` 直接 exit 0；命中缓存打印并 exit 0
- [x] 前置检查：`command -v bun`；`"." + PACKAGES` 逐个 `[ -d "$p/node_modules" ]`，缺失则报 `bun install`
- [x] `run_step <label> <cmd...>`：打印 label、流式输出、成功打 ✅+耗时、失败打 ❌+耗时并记录 `FAILED_STEP`
- [x] 执行序列：`bun run typecheck` → 每包 `bash -c "cd '$p' && bun test"`；任一失败即 exit 1
- [x] 全绿时写入缓存（`BASELINE_NO_CACHE=1` 不写），打印总耗时

验证：

```bash
bash scripts/baseline-check.sh        # 预期：约 107s，末行 "✅ 基线检查通过"，exit 0
bash scripts/baseline-check.sh        # 预期：立即 "✅ 基线缓存命中"，exit 0
BASELINE_NO_CACHE=1 bash scripts/baseline-check.sh   # 预期：重跑全量
BASELINE_SKIP=1 bash scripts/baseline-check.sh       # 预期：立即 exit 0
```

- [x] Commit: `feat(scripts): add baseline-check as single source of truth for merge gate`

---

### Task 2: pre-merge-commit hook

**Files:** Create: `.githooks/pre-merge-commit`

- [x] 守卫（任一不满足即 `exit 0`）：脚本存在于 `$ROOT/scripts/baseline-check.sh`；`git symbolic-ref --short -q HEAD` == `main`；`$(git rev-parse --git-dir)/MERGE_HEAD` 存在
- [x] 调用 `bash "$ROOT/scripts/baseline-check.sh"`，失败时向 stderr 打印 `git merge --abort` 指引后 `exit 1`
- [x] `chmod +x`

验证（在 Task 7 的 scratch 仓库执行）：非 FF 合并且有失败测试 → 被拦；feature 分支合并 main → 放行。

- [x] Commit: `feat(hooks): block non-fast-forward merges to main until baseline passes`

---

### Task 3: pre-push hook

**Files:** Create: `.githooks/pre-push`

- [x] `while read -r local_ref local_sha remote_ref remote_sha; do ...; done` **先读净 stdin**（否则 git 侧 SIGPIPE）
- [x] 只认 `remote_ref == refs/heads/main`；`local_sha` 为 40 个 0（删除分支）时跳过
- [x] 未命中 main 直接 `exit 0`
- [x] `BASELINE_TREE_KEY=$(git rev-parse "$MAIN_SHA^{tree}")` 后 export 再调脚本；失败 `exit 1` 并提示 `git push --no-verify` 是应急口
- [x] `chmod +x`

- [x] Commit: `feat(hooks): block pushes to main until baseline passes`

---

### Task 4: setup-hooks.sh + prepare

**Files:** Create: `scripts/setup-hooks.sh`; Modify: `package.json`

- [x] `git config --local core.hooksPath .githooks`；已等于目标则打印已安装并退出；已存在**其他**值则报错退出（除非 `--force`）
- [x] `chmod +x .githooks/*`
- [x] `--check` 模式：只校验不修改，未安装则 exit 1
- [x] `package.json` scripts 加 `"prepare": "bash scripts/setup-hooks.sh"`

验证：

```bash
bash scripts/setup-hooks.sh --check   # 未装：exit 1；装完：exit 0
bun install                            # 预期：输出 "✅ 已设置 core.hooksPath=.githooks"
```

- [x] Commit: `chore: auto-install git hooks via bun install prepare`

---

### Task 5: CI workflow

**Files:** Create: `.github/workflows/baseline.yml`

- [x] `on: push/pull_request` 均 `branches: [main]`；`permissions: contents: read`；`timeout-minutes: 15`
- [x] `actions/checkout@v5` → `oven-sh/setup-bun@v2`（`bun-version: latest`，与 `build-release.yml` 一致）→ `bun install` → `bash scripts/baseline-check.sh`（`env: BASELINE_NO_CACHE: "1"`）
- [x] 不得使用 `bun install --frozen-lockfile`（`bun.lock` 未入库）

- [x] Commit: `ci: run baseline check on main push and PR`

---

### Task 6: AGENTS.md

**Files:** Create: `AGENTS.md`

- [x] 禁令表（附实测耗时/失败数）：根 `bun run typecheck`、根裸 `bun test`、全量 build
- [x] 允许清单：单包 `typecheck`/`lint`、`bun test <单个测试文件>`、改动包全量测试；各包耗时标注
- [x] 说明基线由 pre-merge-commit / pre-push / CI 自动执行，agent 不需要手动跑
- [x] 纪律：不得 `--no-verify`；验证声明须附实际跑过的 scoped 命令与输出
- [x] 速查表：安装/检查/手动跑/关缓存/应急跳过
- [x] 注明文件名原因：pi 只加载 `AGENTS.md`/`CLAUDE.md`

- [x] Commit: `docs: add AGENTS.md with scoped-check policy`

---

### Task 7: 门禁自测

**Files:** Create: `scripts/tests/baseline-gate.test.sh`

- [x] 每个用例在 `mktemp -d` 下新建 scratch git 仓库（`git init -b main`、`core.hooksPath` 指向**真实仓库**的 `.githooks`、`scripts/baseline-check.sh` 换成 stub：受 `BASELINE_STUB_PASS` 控制、写计数文件）
- [x] 断言：① main 上 `merge --no-ff` 且 stub 失败 → 非 0 且未生成 merge commit；② feature 上合并 main → 0；③ main 上 `merge --squash` 后 `push origin main` → 被拦；④ 推送到 `refs/heads/dev` → 放行；⑤ 失败时缓存文件不存在
- [x] 断言脚本自带 `assert_eq`/`fail` 计数，末尾汇总，全绿 exit 0
- [x] 运行 `bash scripts/tests/baseline-gate.test.sh` 并全绿

- [x] Commit: `test(hooks): add self-test harness for the merge baseline gate`

---

### Task 8: 本仓库真实验证

- [x] `bash scripts/setup-hooks.sh` 后 `git config --get core.hooksPath` == `.githooks`，`ls -l .githooks` 全部可执行
- [x] `bash scripts/baseline-check.sh` 两次：第一次全量通过并写缓存，第二次缓存命中
- [x] 确认 `git status` 未被测试污染（无残留测试数据库/临时文件）

### Task 9: 提交

- [x] `git add -A`（确认不含 `TODO.md` 之外的多余文件；`TODO.md` 是否入库由用户决定）→ 按 Task 提交粒度提交

---

## 执行结果与偏差（2026-09-11 完成）

所有任务已完成，验证结果见 spec "验收标准与实际结果"。执行中发现并修正的问题：

1. **真实 bug（自测 group B 抓到）**：原计划用 `[ -f "$GIT_DIR/MERGE_HEAD" ]` 作为 `pre-merge-commit` 的守卫，但实测 hook 触发时 git **尚未写入 `MERGE_HEAD`** —— 该守卫会让整个门禁静默失效。已移除，并在 hook 注释与 spec 里记下这个约束。
2. **缓存误标风险（主动加固）**：工作区有未 staged 改动时，`git write-tree`（index tree）不再代表被测内容，会把没真正验证过的树标为已通过。已加 `git diff --quiet` 检测：脏工作区禁用缓存（group A7 覆盖）；pre-merge-commit 阶段合并结果全在 index、无未 staged 改动，双闸缓存照常生效。
3. **自测扩充**：原计划 group B/C/D 之外，新增 **group E 端到端**用例（真 hooks + 真 `baseline-check.sh` + 假 bun）：验证门禁合并实跑一次基线并写缓存、随后 push 同棵树走缓存不重跑（即"双闸只跑一遍"）、新提交基线失败时 push 被拦。断言总数 69。
4. **自测本身的两个坑（已修）**：① 自测把自己的 `out.txt` 写进了被测仓库工作区，`git add -A`/`git checkout` 因此报错干扰断言 —— 日志改到 `$WORK/logs/`；② 在 feature 分支上取 `BASE_SHA` 导致"HEAD 不变"断言对象错误。
5. **`package.json` 额外加了一条 `"baseline"` 脚本**（计划里只有 `prepare`）：给人类/agent 一个统一的 `bun run baseline` 入口。
6. **脚本可执行位**：`scripts/baseline-check.sh`、`scripts/setup-hooks.sh`、`scripts/tests/baseline-gate.test.sh` 均 `chmod +x`。
7. **发现既有问题（不在本任务范围）**：`apps/web` 测试对 CPU 负载敏感（单独跑 12/12 通过，满载下 4/4 失败，基线脚本内 4 次失败 2 次），会导致门禁假拦截。已在 spec "已知限制"记录实测数据与两种机制，修复建议单独立任务。
8. `TODO.md` 为本次工作的临时跟踪文件，交付前删除（持久记录在本计划与 spec 里）。
