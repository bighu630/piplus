# Merge 到 main 的基线门禁（Baseline Gate）设计

日期：2026-09-11
状态：已批准（方案 A：pre-merge-commit + pre-push 双闸 + CI 兜底）

## 问题

1. agent 在开发过程中习惯性运行全局检查，代价高且部分命令已损坏（见下表实测）。
2. 仓库没有任何 git hook（`.git/hooks` 已被清空，无 `core.hooksPath`，无 husky），
   也没有任何 AGENTS.md/CLAUDE.md，因此"不要跑全局检查"这条纪律无处声明。
3. 缺少合并到 main 前的统一质量闸：合并到 main 的完整验证目前完全依赖人记得手动跑。

## 实测数据（本仓库，2026-09-11，bun 1.4.0）

| 命令 | 耗时 | 结果 |
| --- | --- | --- |
| `bun test`（仓库根裸跑） | 52.6s | **65 fail / 453 tests** — 测试依赖 CWD，根目录跑必然失败 |
| `bun run test`（根脚本） | 17.0s | pass，但只覆盖 `apps/api` + `packages/db` |
| 逐包测试（api 16.1s + web 4.1s + domain 27.7s + pi-client 10.9s + shared 0.01s + db 0.6s） | ≈60s | 全部 pass |
| `bun run typecheck`（根，7 包串行） | 47.2s | pass（其中 `apps/web` 的 `tsc --noEmit` 占 43.6s） |

逐包 typecheck 耗时：api 5.2s / web 43.6s / db 1.1s / domain 3.8s / pi-client 2.7s / shared 0.6s / desktop 0.3s。

## Git hook 语义（已在临时仓库实测验证）

| 合并/推送方式 → main | `pre-merge-commit`（可阻塞） | `post-merge`（不可阻塞） | `pre-push`（可阻塞） |
| --- | --- | --- | --- |
| fast-forward | ✗ | ✓ | ✓ |
| `--no-ff`（生成 merge commit） | ✓ | ✓ | ✓ |
| `--squash` | ✗ | ✓（arg=1） | ✓ |

补充验证：

- `pre-merge-commit` 返回非 0 时 `git merge` 中止提交（exit=1，HEAD 不变），但**会把 merge 留在进行中状态**，需要 `git merge --abort` 收尾。
- **关键实现约束（实测）**：hook 触发时 git **还没写 `MERGE_HEAD`**（触发点 = 合并结果已进 index、即将生成 merge commit 之前）。用 `[ -f "$GIT_DIR/MERGE_HEAD" ]` 做守卫会让整个 hook 静默失效 —— 这是自测 group B 抓到的一个真实 bug。被拦下**之后** `MERGE_HEAD` 才出现，此时 `git merge --abort` 可正常回退（HEAD 回到合并前、合并内容回退）。
- `pre-merge-commit` 对**任何分支**上的非 FF 合并都会触发，因此**必须自己做 "当前分支 == main" 守卫**，否则把 main 合进 feature 分支（常规操作）也会被拦。
- `git merge --squash` 与 fast-forward 都**不会**触发 `pre-merge-commit`（实测：基线脚本未被调用），这两条路径完全依赖 `pre-push`。
- `core.hooksPath = .githooks`（相对路径）是仓库级配置、worktree 共享，且在 worktree 内按该 worktree 根解析（实测 hook 内 `git rev-parse --show-toplevel` = worktree 根）。

## 目标

- agent 明确知道**不要**跑全局 test/typecheck，并知道该跑什么。
- 合并/推送 main 时基线自动执行，失败即阻塞（本地双闸 + 服务端 CI 兜底）。
- 基线的定义只有一份（hook、CI、人类共用同一脚本），不存在三处漂移。

## 非目标

- 不做 pre-commit 级别的 lint/format（每次提交都跑会拖慢正常开发）。
- 不引入 husky 等依赖（bun workspace + `core.hooksPath` 零依赖即可）。
- 不改变各包已有的测试/typecheck 脚本。

## 组成

### 1. `AGENTS.md`（仓库根，中文）

声明禁令（全局 typecheck、根目录裸 `bun test`、全量 build）、允许的 scoped 检查清单、
基线由谁负责（hook + CI）、纪律（不得 `--no-verify` 绕过）与命令速查表。
文件名必须是 `AGENTS.md`：pi 只自动加载 `AGENTS.md` / `CLAUDE.md`，`AGENT.md` 不会被读取。

### 2. `scripts/baseline-check.sh` —— 基线唯一真相源

- 拒绝从仓库根裸跑 `bun test`，改为**逐包**执行 6 个包。
- 顺序：全量 `bun run typecheck` → 逐包 `bun test`；失败即停，打印失败步骤。
- 前置检查：`bun` 存在、工作区**根** `node_modules` 存在（worktree 缺依赖时给清晰报错，而非满屏 module not found）。
  - 不能按包检查：bun 把依赖 hoist 到根，无依赖的包（如 `packages/shared`）本来就不会有 `node_modules` —— 按包检查会在 fresh install / 新 worktree / CI 上误报"缺依赖"（已修，由自测 A6/A7 覆盖）。
- tree 缓存：key 为**即将被检查的那棵树**，通过后写入 `<git-common-dir>/baseline-passed-tree`，命中即跳过。
  - 默认取 `git write-tree`（index tree）。原因：`pre-merge-commit` 阶段合并结果已进 index 但 commit 尚未生成，此时 `HEAD^{tree}` 仍是合并前的旧树，用它当 key 会产生错误的缓存语义。
  - `pre-push` 用被推送 sha 的 tree（`BASELINE_TREE_KEY`）。
  - 缓存放在 `git-common-dir`（而非 `.git`）以便跨 worktree 共享。
  - **工作区有未 staged 的改动的禁用缓存**（`git diff --quiet` 检测）：此时"被测内容" ≠ index tree，用 index tree 当 key 会把一棵没真正验证过的树标成已通过。pre-merge-commit 阶段合并结果全部在 index 里、无未 staged 改动，所以双闸缓存照常生效。
- 环境变量：`BASELINE_SKIP=1`（应急跳过）、`BASELINE_NO_CACHE=1`（强制实跑）、`BASELINE_TREE_KEY`。

### 3. `.githooks/pre-merge-commit`

守卫顺序：非 git 仓库 → 脚本不可执行 → 当前分支不是 `main` → 无 `MERGE_HEAD` → 全部直接 `exit 0`。
失败时打印恢复指引（`git merge --abort`，因为 Git 会留下进行中的 merge）。

### 4. `.githooks/pre-push`

先读完 stdin（防 SIGPIPE），只为 `refs/heads/main` 触发；删除分支（全 0 sha）跳过；
被推送 sha 与当前 checkout 不一致时提示"基线针对当前 checkout 运行"。

### 5. `.github/workflows/baseline.yml`

`on: push/pull_request → main`，复用 `oven-sh/setup-bun@v2`，跑同一个 `scripts/baseline-check.sh`。
用 `bun install`（**不能**用 `--frozen-lockfile`：`bun.lock` 被 .gitignore 忽略且未入库）。

### 6. `scripts/setup-hooks.sh`

幂等安装：`chmod +x` + `git config --local core.hooksPath .githooks` + 自检；
`--check` 只报告不修改；已存在**其他** hooksPath 时需 `--force` 才覆盖（避免踩掉用户环境）。
根 `package.json` 加 `"prepare": "bash scripts/setup-hooks.sh"`，`bun install` 时自动接线（已验证 bun 1.4.0 会执行 `prepare`）。

### 7. `scripts/tests/baseline-gate.test.sh` —— 门禁自测

在临时目录构造 scratch 仓库验证（共 69 条断言，全绿；真实基线不会被执行，用假 bun / stub 替代）：

- group A：`baseline-check.sh` 的缓存命中/强制实跑/跳过/失败不写缓存/缺 node_modules/脏工作区禁用缓存
- group B：`pre-merge-commit` 拦截、`--abort` 回退、合并 main 进 feature 分支放行、FF 盲区
- group C：`pre-push` 拦 main、放行 dev、`--no-verify` 绕过
- group E：**端到端**（真 hooks + 真脚本 + 假 bun）—— 门禁合并实跑一次基线并写缓存，随后 push 同棵树走缓存不重跑（验证"双闸只跑一遍"），新提交基线失败时 push 被拦
- group D：`setup-hooks.sh` 安装/幂等/`--check`/拒绝覆盖/`--force`

hook 最常见的失效方式是"静默不再触发"，没有自测就等于没有门禁 —— 该自测在开发过程中确实抓到了 `MERGE_HEAD` 守卫这个真实 bug。

## 已知限制

- 服务端 PR 合并不会触发本地 hook，由 CI workflow 兜底（CI 是红 X，不能阻止已合并的提交）。
- `git merge --no-verify` 与 `git push --no-verify` 可绕过；`BASELINE_SKIP=1` 同理。纪律靠 AGENTS.md 约束。
- 基线的 typecheck/测试针对**当前 checkout**：`pre-push` 推送与 checkout 不同的分支时结果仅供参考（hook 会打印警告）。
- 双闸场景下同一棵树最多跑一次（缓存保证），但缓存被清时最坏会跑两遍（约 3.6 分钟）。
- **基线本身曾经不稳定（既有问题，已修复）**：`apps/web` 曾出现随机失败（实测：单独跑 12/12 通过；人为加 6 个满载进程后 4/4 失败；在基线脚本内 4 次失败 2 次）。根因不是那些用例本身，而是 `AskQuestionCard` 问卷的 220ms「自动跳题」`setTimeout` 未在卸载时清理：定时器到点时前序 DOM 测试文件已在 `afterAll` 把 `globalThis.window` 还原为 `undefined`，React `dispatchSetState` 读 `window.event` 抛 TypeError，把当时正在跑的任意测试一并打挂（所以“背锅”的测试每次都不同）。已在独立任务修复：commit `20e1fff`（含假时钟化的节流测试与两条回归测试）。

## 验收标准与实际结果

| # | 验收标准 | 结果 |
| --- | --- | --- |
| 1 | `bash scripts/setup-hooks.sh` 后 `core.hooksPath == .githooks`，hook 可执行 | ✅ 且 `bun install` 的 `prepare` 会自动重装（已验证：先清空再 install，配置被自动写回） |
| 2 | main 上非 FF 合并 + 失败基线被阻塞，且提示 `git merge --abort` | ✅ group B1/B2（含 `--abort` 回退验证） |
| 3 | feature 分支合并 main 不被阻塞 | ✅ group B4 |
| 4 | FF / squash merge 后的 `git push origin main` 被 pre-push 阻塞 | ✅ group C2/C3 |
| 5 | 同一棵树第二次运行走缓存并立即返回 0；失败时缓存不写入 | ✅ group A1–A4；双闸端到端见 group E2 |
| 6 | `bash scripts/tests/baseline-gate.test.sh` 全部通过 | ✅ 69/69 |
| 7 | CI workflow 跑同一个 `scripts/baseline-check.sh` | ✅ `.github/workflows/baseline.yml` |
| 8 | 全量基线在本仓库真实跑通（含曾随机失败的 apps/web） | ✅ 修复 flaky 后重跑：7 步全绿，108s（tree `ce3bf4cd`） |
