# AGENTS.md

本文件是本仓库（piplus）所有 AI agent 的工作约定。核心铁律一句话：

> **在开发过程中不要运行全局 test / typecheck。只跑你改动范围内的检查。**
> 跨包基线在**合并到 main 时**由 hook 和 CI 自动执行。

（文件名说明：pi 与多数 agent 只自动加载 `AGENTS.md` / `CLAUDE.md`，不会加载 `AGENT.md`。）

## 1. 禁止运行的命令

| 禁止 | 为什么（本仓库实测，2026-09-11，bun 1.4.0） |
| --- | --- |
| `bun run typecheck`（仓库根，7 个包串行） | 47.2s，其中 `apps/web` 的 `tsc --noEmit` 独占 43.6s |
| `bun test`（仓库根直接裸跑） | **已损坏**：453 个测试中 65 个失败（测试依赖 CWD），且耗时 52.6s |
| `bun run test`（根脚本，看着像全局但不完整） | 只覆盖 `apps/api` + `packages/db`，漏掉 web/domain/pi-client/shared，容易给出虚假的安全感 |
| `bun run build` / `build:desktop` / 各 app 的全量构建 | 与当前改动无关，且远慢于测试 |
| 遍历所有包跑 typecheck/测试 | 约 107s，跨包基线不属于单个 agent 的改动范围 |

## 2. 应该运行的检查（scoped）

在**你改动的那个包内**做检查，一次一个包：

```bash
# 单包类型检查
cd apps/api && bun run typecheck              # 5.2s
cd packages/domain && bun run typecheck       # 3.8s
cd packages/pi-client && bun run typecheck    # 2.7s
cd packages/db && bun run typecheck           # 1.1s
cd packages/shared && bun run typecheck       # 0.6s
cd apps/web && bun run lint                   # 43.6s ⚠️ 只在改了 web 时跑

# 单个测试文件（首选，秒级）
cd apps/api && bun test src/routes/sessions.test.ts
cd packages/domain && bun test src/session/runtime.test.ts

# 改动包的全量测试（改得多或不确定影响面时）
cd apps/api && bun test                       # 16.1s
cd packages/domain && bun test                # 27.7s
cd packages/pi-client && bun test             # 10.9s
cd apps/web && bun test                       # 4.1s
cd packages/db && bun test                    # 0.6s
```

有测试的包：`apps/api`、`apps/web`、`packages/db`、`packages/domain`、`packages/pi-client`、`packages/shared`。
改动哪个包就测哪个包；跨包改动时，额外补跑被影响的那个下游包。

## 3. 基线检查自动发生，不需要你手动跑

合并/推送到 main 时有双闸 + 服务端兜底，三者调用**同一个** `scripts/baseline-check.sh`：

| 闸 | 触发条件 | 能否阻塞 |
| --- | --- | --- |
| `.githooks/pre-merge-commit` | 在 `main` 上执行 `git merge`（生成 merge commit，即非 FF） | 能 |
| `.githooks/pre-push` | 推送到 `refs/heads/main`（覆盖 FF / `--squash` 这两条 pre-merge-commit 不触发的路径） | 能 |
| `.github/workflows/baseline.yml` | `push` / `pull_request` → main | 只能红 X（本地 hook 不覆盖 GitHub 侧操作） |

基线内容：全量 `bun run typecheck` + 6 个包逐包 `bun test`，约 107s。
同一棵树已在通过缓存里时自动跳过（缓存文件在 `<git-common-dir>/baseline-passed-tree`，worktree 间共享）。

**所以**：agent 完成一个任务时，用第 2 节的 scoped 检查满足"完成前验证"，不要为了验证去跑全量。

## 4. 纪律

- **不要用 `--no-verify` 绕过 hook。** 基线失败就修，别绕过。
- 不要用 `BASELINE_SKIP=1` 图省事；它只是"用户明确知情时"的应急开关。
- 在 main 上合并被 hook 拦下后，注意 Git 会把 merge 留在进行中状态：用 `git merge --abort` 回到合并前。
- 声明任务完成时必须附真实证据（贴出你实际跑过的 scoped 命令与输出），不要凭"应该没问题"下结论。
- 如果确实需要跑全量，用第 6 节的 `bun run baseline`，而不是自己拼全局命令。

## 5. 发布流程

发布（dev → main → tag）的完整步骤见 **`docs/release-process.md`**。要点：

- 发布**不需要 worktree**，在主工作区直接操作即可
- 先跑 `bash scripts/release-check.sh`：它会检查每个 worktree / 分支是否已进入 main，**未进入则阻塞** ——
  此时不要自己决定，**先询问用户是否需要合并**；已合并的临时分支用 `--prune-merged` 清理
- 版本号只改 `apps/desktop/package.json`（唯一来源），在 dev 上提交
- 合并必须用 `git merge --no-ff dev`（fast-forward 不触发门禁），门禁会跑全量基线
- push 没权限就跳过，不要强推、不要改 remote；tag 会触发 Release 构建，不要乱打

## 6. 速查表

| 目的 | 命令 |
| --- | --- |
| 安装/刷新 hooks | `bash scripts/setup-hooks.sh`（`bun install` 会通过 `prepare` 自动执行） |
| 检查 hooks 是否装好 | `bash scripts/setup-hooks.sh --check` |
| 手动跑完整基线 | `bun run baseline` 或 `bash scripts/baseline-check.sh` |
| 忽略缓存强制实跑 | `BASELINE_NO_CACHE=1 bun run baseline` |
| 应急跳过基线 | `BASELINE_SKIP=1 git merge ...` / `git push --no-verify` |
| 发布前检查（只读） | `bash scripts/release-check.sh` |
| 清理已合并的临时分支 | `bash scripts/release-check.sh --prune-merged` |
