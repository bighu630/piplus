# 发布流程（Release Process）

适用范围：piplus 的版本发布（dev → main → tag → Release 构建）。
**发布不需要 worktree**：直接在主工作区操作即可（历史上用 worktree 是为了隔离并行开发，发布本身不需要）。

## 一句话流程

```bash
bash scripts/release-check.sh                 # 1. 发布前检查（只读，有阻塞项会退出 1）
bash scripts/release-check.sh --prune-merged  # 2. 删掉已合并进 main 的临时分支
# 3. 在 dev 上改版本号并提交
# 4. 合并 dev → main（门禁自动跑全量基线）
# 5. push（没有权限就跳过，本地发布依然完成）
# 6. 打 tag 并 push tag → 触发 Release 构建
```

## 详细步骤

### 1. 发布前检查

```bash
bash scripts/release-check.sh
```

它会检查并给出结论（只读，不改任何东西）：

| 检查 | 行为 |
| --- | --- |
| 未完成的 merge/rebase、工作区是否干净 | 有未完成的 git 操作 → 阻塞；未提交改动 → 提示（点击进入发布内容的是已提交内容） |
| **worktree** | 每个 worktree 的分支是否已进入 `main`；未进 `main` → **阻塞**，此时必须**询问用户是否需要先合并** |
| **本地分支** | 已合并进 `main` 的列为可删除；未合并的 → **阻塞**（同样先问用户） |
| 版本号 | 打印工作区与 `main` 的版本（见下方"版本号只有一个来源"） |
| 门禁 | `core.hooksPath=.githooks` 且两个 hook 可执行 |
| 远端 | 与 `origin/main`、`origin/dev` 的领先/落后关系；离线时自动降级为提示 |

退出码 0 = 无阻塞项；1 = 有阻塞项，先处理（未合并的 worktree/分支**不要自己决定**，先问用户）。

### 2. 清理已合并的分支

```bash
bash scripts/release-check.sh --prune-merged
```

只删除**已完全合并进 `main`** 的临时分支；`main` / `dev` 永不删除；正被某个 worktree 检出的分支会跳过。
底层用 `git branch -d`（未合并的分支会被 Git 自己拒绝，天然兜底）。

### 3. 改版本号

版本号**只有一个来源**：

```
apps/desktop/package.json   ← "version": "x.y.z"（唯一需要改的文件）
```

- 前端界面显示的版本不来自仓库文件：`apps/web/vite.config.ts` 里 `__APP_VERSION__ = process.env.APP_VERSION || 'dev'`，
  而 CI 在打 tag 时用 `VERSION=${GITHUB_REF_NAME#v}` 注入（见 `.github/workflows/build-release.yml`）。
  所以**真正决定发布版本号的是 tag**，`package.json` 是给 Electron 打包器用的。
- 历史上每次 bump 都只改这一个文件，提交信息统一为 `chore: bump version to vX.Y.Z`。
- 在 **dev** 上提交。

```bash
# 例：0.3.0 → 0.4.0
sed -i 's/"version": "0.3.0"/"version": "0.4.0"/' apps/desktop/package.json
git add apps/desktop/package.json
git commit -m "chore: bump version to v0.4.0"
```

### 4. 合并 dev → main

```bash
git checkout main
git merge --no-ff dev -m "merge: release vX.Y.Z from dev"
```

- 必须用 `--no-ff`：这样才会生成 merge commit，从而触发 `pre-merge-commit` 门禁（fast-forward 不触发）。
- 门禁会跑全量基线（typecheck + 6 个包测试，约 75～110s）。**失败即阻塞**，不会生成合并提交。
- 失败后的恢复：`git merge --abort` 回到合并前（不要用 `--no-verify` 绕过，见 AGENTS.md 纪律）。
- 完成后 `git checkout dev` 继续开发。

### 5. push

```bash
git push origin dev
git push origin main
```

- 推送 `main` 会再触发 `pre-push` 门禁；同一棵树会命中缓存（秒过），不同树才会实跑基线。
- **没有权限就跳过**：不要为此改 remote、不要强推。本地发布状态（dev/main 已合并）已经成立，把"未推送"如实记下来即可。

### 6. 打 tag（触发 Release 构建）

```bash
git tag vX.Y.Z <main 上的 release merge commit>
git push origin vX.Y.Z
```

- tag 打在 **release merge commit** 上（历史约定：`v0.2.21` → `9839eee` 就是那次 release merge）。
- `.github/workflows/build-release.yml` 监听 `v*` tag：会构建 Electron 三平台包 + Docker 镜像。
  **所以 tag 不要乱打**（打错并推送会真的跑一轮发布构建）。
- 没有 push 权限时，tag 可以只在本地创建，或干脆跳过，等有权限时再补。

## 版本号/门禁的常见坑

| 坑 | 说明 |
| --- | --- |
| fast-forward 合并不触发门禁 | `main` 落后于 `dev` 时直接 `git merge dev` 会是 FF，跳过 `pre-merge-commit`；要么用 `--no-ff`，要么依赖 `pre-push` 兜底 |
| 门禁缓存 | 通过的树记录在 `<git-common-dir>/baseline-passed-tree`，worktree 间共享；同一棵树不重复跑。`BASELINE_NO_CACHE=1` 可强制实跑 |
| hook 环境泄漏 | git 会把自己的内部变量（`GIT_DIR`、`GIT_REFLOG_ACTION` 等）导出给 hook 进程，曾导致 api 的 fixture 用例指错仓库、甚至改动真实仓库。`scripts/baseline-check.sh` 已在开头清掉全部 `GIT_*`，不要再把这段删掉 |
| 假 tag | 测试 fixture 曾经在真实仓库里留下 `v1.0.0`/`v2.0.0` 之类假 tag，一旦推送就会触发发布构建。发现可疑 tag 先核对 `git log -1 <tag>` 的作者/提交信息再删除 |

## 回滚

发布后发现问题时：

- 只是本地/远端分支要退回：`git checkout main && git revert -m 1 <merge commit>`（保留历史，推荐）；`git reset --hard` 仅限尚未推送时使用。
- 已推送的 tag：`git push origin :refs/tags/vX.Y.Z`（会影响已产出的 Release，慎用）。
