# Git Tag 创建与推送到远程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Git 页面支持「新建 tag」并把 tag 推送到远程；显示每个 tag 的「未推送」状态，支持逐个推送与一键推送全部未推送。

**Architecture:** 后端新增 3 个端点（创建 tag、推送 tags、读远程 tag 状态）+ 扩展既有 `/git/tags` 增加 `sha` 字段用于比对；前端在既有 tag 面板内加「新建标签」表单、每行「未推送」徽标与推送按钮、一键推送按钮。

**Tech Stack:** Bun + Hono + Drizzle（api）、React + TanStack Query + Tailwind（web）、bun:test

**Worktree:** `/home/bighu/server/piplus/.worktrees/git-tag-push`（分支 `feat/git-tag-push`，base = dev `c89b08d`）

---

## 用户已确认的决策（不可偏离）

1. **范围**：推送 + 创建（UI 里能新建 tag 并推送到远程）
2. **粒度**：逐个推送 + 一键全部，两个都要
3. **同步状态**：显示「未推送」徽标，只推未推送的（接受 `git ls-remote` 的网络开销）
4. **remote**：不指定/不硬编码 remote，交给 git 解析
5. **覆盖语义**：安全 —— 远程已有同名 tag 且不一致时直接报错，**不覆盖**（禁止 `--force`）
6. **隔离**：独立 worktree（主仓被其他会话占用）

**沿用既有约束**：worktree 相关逻辑保持不动（见文末冻结区）。

---

## 实测验证过的 git 行为（本设计的依据）

| 事实 | 实测结果 |
|---|---|
| `git push refs/tags/x`（不给 remote） | **失败** —— git 把 `refs/tags/x` 当作 repository 参数，报 "Please make sure you have the correct access rights and the repository exists." |
| `git push refs/tags/x:refs/tags/x`（不给 remote） | 同样**失败**（同上原因） |
| `git push --tags`（不给 remote） | **成功**，git 自己解析默认 remote |
| `git push <remote> refs/tags/x` | **成功** |
| `git ls-remote --tags` 输出 | `<sha>\trefs/tags/<name>`；annotated tag 会**额外**多一行 `refs/tags/<name>^{}`（解引用到 commit）→ **必须过滤 `^{}` 行** |
| `git tag --list --format='%(objectname)'` | annotated → **tag 对象 sha**；lightweight → commit sha |
| 与远程比对口径 | 本地 `%(objectname)` 与远程 `refs/tags/<name>` 的 sha **两者都相等**（annotated/lightweight 均成立）→ sha 比对有效 |
| `execFileSync('git', ['tag','-a',name,'-m',msg])` | message 原样存储，`$(...)`/反引号/`$$`/引号**均不被 shell 解释** |

### ⚠️ 由此产生的对决策 4 的必要技术修正（需用户知悉）

用户选择「不指定 remote，交给 git 自己解析」。但实测表明：**显式 tag refspec 无法在省略 remote 的情况下推送**（git 会把第一个参数当作 repository）。

采用的方案：**用 git 自己解析出 remote 名，再显式传入**——
`git config --get branch.<current>.remote` → 回退 `git config --get remote.pushDefault` → 回退 `git remote` 的第一个 → 都没有则报 `NO_REMOTE`。

这不硬编码 `origin`，仍属「交给 git 解析」，只是把 git 的解析结果取出来显式使用。用「解析 + 显式传入」而非 `git push --tags` 的原因：后者会连已同步的 tag 一起推，一旦某个无关 tag 在远程冲突会导致**整批推送失败**；而显式 refspec 能精确地「只推未推送的」。

### 🔴 顺带发现的安全问题（本计划范围内修复，写法上避免重蹈）

`execGit()` 用 `execSync` 拼接 shell 字符串。实测确认既有 `git/commit` 路径存在**命令注入**：commit message 为 `fix $(touch /tmp/PWNED_committest) issue` 时，`touch` **真的被执行**了（提交信息变成 `fix  issue`）。同类风险还存在于 `-c user.name="${cfg.userName}"` / `user.email`。

**本计划要求**：所有新增代码涉及自由文本（tag message）处**必须使用 `execFileSync` argv 形式（不经 shell）**。既有 commit/push 的注入面不在本计划范围内（另行报告，不擅自扩大改动）。

---

## API 契约（并行开发的冻结接口）

### 1. `GET /api/v1/sessions/:sessionId/git/tags`（扩展：新增 `sha`）

```json
{
  "session_id": "s1", "cwd": "/repo", "detached": false,
  "tags": [{ "name": "v1", "is_current": false, "is_annotated": true,
             "date": "2026-09-11", "subject": "release", "sha": "9a8d0563c48ebb293627958926765435d3bbc41c" }]
}
```
- tag 列表命令的 format 串尾部追加 `|||%(objectname)`；**其余字段与现有响应逐字节等价**
- 既有 10 个 git 测试必须继续通过

### 2. `POST /api/v1/sessions/:sessionId/git/tags`（新建 tag）

请求：`{ "name": "v1.2.0", "message": "optional" }`
- `name` 处理顺序：trim → 去掉前导 `refs/tags/` → 校验非空 → 不得以 `-` 开头 → 匹配 `/^[a-zA-Z0-9._\-/]+$/`
- 空名 → 400 `{ error: { code: 'EMPTY_TAG_NAME', message: 'Tag name is required' } }`
- 非法名 → 400 `{ error: { code: 'INVALID_TAG_NAME', message: 'Tag name contains invalid characters' } }`
- `message` trim 后非空 → annotated（`tag -a <name> -m <message>`）；否则 → lightweight（`tag <name>`）
- **通过 `execFileSync('git', argv)` 执行，不经 shell**
- 200：`{ session_id, cwd, result: 'ok', stdout, name, annotated: boolean }`
- 失败（如重名）：500 `{ session_id, cwd, result: 'error', stderr, name, error: { code: 'TAG_CREATE_FAILED', message: stderr } }`

### 3. `POST /api/v1/sessions/:sessionId/git/tags/push`（推送 tag）

请求：`{ "names": ["v1"] }`（`names` 省略或空数组 = 推送全部未推送的）
- 解析 remote（上述三级回退）；解析不到 → 400 `{ error: { code: 'NO_REMOTE', message: 'No git remote is configured' } }`
- `names` 给定时逐个校验（同 §2 的名称规则）
- `names` 省略时：计算未推送集合 = 本地 `sha` ≠ 远程 `refs/tags/<name>` 的 sha（含远程不存在）
- 未推送集合为空 → 200 `{ result: 'ok', stdout: 'Everything up-to-date.', pushed: [], remote }`（不执行 git）
- 执行：`git push <remote> refs/tags/a:refs/tags/a refs/tags/b:refs/tags/b`（**禁止 `--force`**；非快进由 git 报错 → 满足"不覆盖"）
- 200：`{ session_id, cwd, result: 'ok', stdout, pushed: string[], remote }`
- 失败：500 `{ session_id, cwd, result: 'error', stderr, pushed: [], remote, error: { code: 'TAG_PUSH_FAILED', message: stderr } }`

### 4. `GET /api/v1/sessions/:sessionId/git/remote-tags`（读远程 tag 状态）

- 命令：`git ls-remote --tags <remote>`，**过滤以 `^{}` 结尾的 ref**，只保留 `refs/tags/<name>`，映射为 `{ name, sha }`
- remote 解析失败 / 网络失败 / 认证失败 → **一律 200 优雅降级**（不抛 500，避免把页面打红）：
  `{ session_id, cwd, remote_ok: false, remote: string|null, error: string|null, tags: [] }`
- 成功：`{ session_id, cwd, remote_ok: true, remote: 'origin', error: null, tags: [{ name, sha }] }`
- `execFileSync` 传 `timeout: 10_000` 防止网络挂死

### 5. 前端类型契约

```ts
// api.ts
export function getGitTags(sessionId: string);   // 返回类型 tags 项追加 sha: string
export function createGitTag(sessionId: string, name: string, message?: string);
export function pushGitTags(sessionId: string, names?: string[]);
export function getRemoteTags(sessionId: string);

// hooks.ts
export function useCreateGitTagMutation();  // 成功后 invalidate git-tags
export function usePushGitTagsMutation();   // 成功后 invalidate git-tags + remote-tags
export function useRemoteTags(sessionId: string | null); // queryKey ['session','git-remote-tags',sessionId], staleTime 30_000
```

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/api/src/routes/sessions/routes/git.ts` | 3 个新端点 + tags 加 sha + remote 解析 helper | Modify |
| `apps/api/src/routes/sessions/git.test.ts` | 上述全部行为的测试 | Modify（追加） |
| `apps/web/src/lib/api.ts` | 4 个 API 函数 + 类型 | Modify |
| `apps/web/src/lib/hooks.ts` | 3 个 hook | Modify |
| `apps/web/src/components/TabGitDiff.tsx` | 新建表单、未推送徽标、推送按钮 | Modify |

**并行切分（零文件重叠）：**
- **Worker A（后端）** = `git.ts` + `git.test.ts`
- **Worker B（前端）** = `api.ts` + `hooks.ts` + `TabGitDiff.tsx`

---

### Task A: 后端 tag 创建 / 推送 / 远程状态

**Files:**
- Modify: `apps/api/src/routes/sessions/routes/git.ts`
- Modify: `apps/api/src/routes/sessions/git.test.ts`

- [ ] **Step A1: 加安全 exec helper（模块作用域）**

```ts
import { execFileSync } from 'node:child_process';

/** Shell-free git invocation. Required for any argument that is free-form user text. */
function execGitFileArgs(cwd: string, args: string[], timeoutMs?: number): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  }).toString();
}
```

- [ ] **Step A2: 加 remote 解析与未推送计算 helper**

```ts
function resolveGitRemote(cwd: string): string | null {
  const tryConfig = (key: string): string | null => {
    try { return execGit(cwd, `config --get ${key}`).trim() || null; } catch { return null; }
  };
  try {
    const cur = execGit(cwd, 'rev-parse --abbrev-ref HEAD').trim();
    if (cur && cur !== 'HEAD') {
      const fromBranch = tryConfig(`branch.${cur}.remote`);
      if (fromBranch) return fromBranch;
    }
  } catch { /* detached or no commits */ }
  const pushDefault = tryConfig('remote.pushDefault');
  if (pushDefault) return pushDefault;
  try {
    const first = execGit(cwd, 'remote').split('\n').map((l) => l.trim()).filter(Boolean)[0];
    return first ?? null;
  } catch { return null; }
}

function listRemoteTagShas(cwd: string, remote: string, timeoutMs?: number): Map<string, string> {
  const out = execGitFileArgs(cwd, ['ls-remote', '--tags', remote], timeoutMs);
  const map = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    if (ref.endsWith('^{}')) continue;          // annotated deref line — skip
    if (!ref.startsWith('refs/tags/')) continue;
    map.set(ref.slice('refs/tags/'.length), sha.trim());
  }
  return map;
}
```

- [ ] **Step A3: 写失败测试**（追加到 `git.test.ts`）

命名与断言要求：
1. `POST /git/tags` 创建 lightweight：无 message → 200，`annotated === false`，`git cat-file -t refs/tags/<name>` 为 `commit`
2. `POST /git/tags` 创建 annotated：带 message → 200，`annotated === true`，`git cat-file -t refs/tags/<name>` 为 `tag`，且 message 内容原样保存
3. **注入防护**：name 合法、message 含 `$(touch <tmpfile>)` 与反引号 → 200，且 `<tmpfile>` **不存在**，tag message 原样含这些字符
4. 重名 → 500，`error.code === 'TAG_CREATE_FAILED'`
5. 校验：空名 → 400 `EMPTY_TAG_NAME`；`-f` → 400 `INVALID_TAG_NAME`；`bad name!` → 400；`refs/tags/v9` 前缀被剥离后创建出的 tag 名为 `v9`
6. `GET /git/tags` 返回的每项都有非空 `sha`，且 annotated 的 sha ≠ 其指向 commit 的 sha（证明是 tag 对象 sha）
7. `GET /git/remote-tags`：无 remote 时 `remote_ok === false`；配好本地 bare remote 后 `remote_ok === true` 且 tags 与远程一致；**annotated tag 不出现 `^{}` 残留名字**
8. `POST /git/tags/push` 逐个推送：把一个 tag 推到本地 bare remote 后，`ls-remote` 能看到它
9. `POST /git/tags/push` 省略 names → 只推未推送的：先推一个，再加一个新 tag，第二次推送 `pushed` 只含新 tag
10. **不覆盖**：远程 tag 指向 A、本地同名 tag 指向 B → push 返回 500，`error.code === 'TAG_PUSH_FAILED'`，且远程 sha **仍是 A**（未被覆盖）
11. 无 remote 时 push → 400 `NO_REMOTE`
12. 回归：既有 10 个用例全过

测试用本地 **bare 仓库**作 remote（`git init --bare`），避免任何真实网络。

- [ ] **Step A4: 跑测试确认失败** → `cd apps/api && bun test src/routes/sessions/git.test.ts`，新用例应 FAIL（端点 404）

- [ ] **Step A5: 实现 tags 端点加 `sha`**：format 串追加 `|||%(objectname)`，解析第 5 段为 `sha`

- [ ] **Step A6: 实现 `POST /git/tags`**：按契约 §2，用 `execGitFileArgs` 执行（argv：`['tag','-a',name,'-m',message]` 或 `['tag',name]`）

- [ ] **Step A7: 实现 `GET /git/remote-tags`**：按契约 §4，优雅降级 + `timeout: 10_000`

- [ ] **Step A8: 实现 `POST /git/tags/push`**：按契约 §3，`git push <remote> <refspec>...`，不加 `--force`

- [ ] **Step A9: 跑测试确认通过 + 全量回归**
```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-push/apps/api && bun test src/routes/sessions/git.test.ts
cd /home/bighu/server/piplus/.worktrees/git-tag-push/apps/api && bun test
cd /home/bighu/server/piplus/.worktrees/git-tag-push/apps/api && bun run typecheck
```
基线：全量 **213 tests / 213 pass / 0 fail**。交付标准：0 fail。

- [ ] **Step A10: 提交**
```bash
git add apps/api/src/routes/sessions/routes/git.ts apps/api/src/routes/sessions/git.test.ts
git commit -m "feat(api): create and push git tags with remote sync status"
```

---

### Task B: 前端新建 / 推送 / 未推送状态

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/hooks.ts`
- Modify: `apps/web/src/components/TabGitDiff.tsx`

- [ ] **Step B1: api.ts** — `getGitTags` 返回类型 tags 项加 `sha: string`；新增 `createGitTag`、`pushGitTags`、`getRemoteTags`（返回类型见契约 §5，用内联类型，不动 `packages/shared/src/dto.ts`）

- [ ] **Step B2: hooks.ts** — 新增 `useCreateGitTagMutation`（成功后 invalidate `git-tags`）、`usePushGitTagsMutation`（success/error 均 invalidate `git-tags` + `git-remote-tags`，因为部分成功也要刷新）、`useRemoteTags`（queryKey `['session','git-remote-tags',sessionId]`，`enabled: Boolean(sessionId)`，`staleTime: 30_000`）

- [ ] **Step B3: TabGitDiff.tsx 数据层**
- 新增 `useRemoteTags` 查询（与 `useGitTags` 同样的 enabled 条件）
- 派生：`const remoteTagShas = new Map((remoteTagsQuery.data?.tags ?? []).map(t => [t.name, t.sha]))`
- 派生：`const isUnpushed = (t) => remoteReady && remoteTagShas.get(t.name) !== t.sha`，其中 `remoteReady = remoteTagsQuery.data?.remote_ok === true`
- 派生：`const unpushedTags = tags?.filter(isUnpushed) ?? []`
- **`anyBusy` 需要把两个新 mutation 的 `isPending` 纳入**（保持既有交互：busy 时禁用操作）

- [ ] **Step B4: TabGitDiff.tsx 新建标签表单**
- tag 面板头部加「新建标签」按钮（tag 模式下显示），点击展开内联表单：名称输入框 + 说明输入框（可选）+ 「创建」与「创建并推送」两个按钮
- 名称输入框 `onKeyDown` Enter 触发「创建并推送」；表单内按钮 `disabled` 当名称为空或 busy
- 成功：`setOpFeedback({ op:'checkout', result:'ok', message: '已创建标签 "x"' / '已创建并推送标签 "x"' })`；失败：展示 `err.message`（后端已把 stderr 放进 `error.message`），沿用 `setTimeout(clearFeedback, 6000)`
- 成功后清空输入并收起表单

- [ ] **Step B5: TabGitDiff.tsx 未推送徽标 + 逐个推送**
- tag 行内：当 `isUnpushed(t)` 为真时显示「未推送」徽标（amber 系），行内加一个推送按钮（`UploadCloud` 或 `ArrowUpCircle` 图标，`e.stopPropagation()` 防止触发行选中），点击 → `pushGitTagsMut.mutateAsync({ sessionId, names: [t.name] })`
- 推送按钮 `disabled` 当 busy
- 远程状态未就绪（`remote_ok === false` 或加载中）→ **不显示**「未推送」徽标与推送按钮，改在面板头部显示一行灰色提示「远程状态不可用」

- [ ] **Step B6: TabGitDiff.tsx 一键推送**
- tag 面板头部：`unpushedTags.length > 0` 时显示「推送未推送 (N)」按钮 → `pushGitTagsMut.mutateAsync({ sessionId })`（省略 names）
- 成功 toast：`已推送 N 个标签`（用返回的 `pushed.length`），失败展示 `err.message`

- [ ] **Step B7: 验证**
```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-push/apps/web && bun run lint
cd /home/bighu/server/piplus/.worktrees/git-tag-push && bun run test:web
```
基线：**261 tests / 261 pass / 0 fail**。交付标准：0 fail。

- [ ] **Step B8: 冻结区自检**
```bash
git diff -U0 HEAD -- apps/web/src/components/TabGitDiff.tsx | grep "^-[^-]"
```
预期删除行只出现在本次明确要改的位置；**不得**出现 worktree 冻结块（W 徽标三元 / `const isWorktreeBranch` / amber 样式+路径尾名 / `{sessionWorktreePath && ...}` badge）相关的删除行。

- [ ] **Step B9: 提交**
```bash
git add apps/web/src/lib/api.ts apps/web/src/lib/hooks.ts apps/web/src/components/TabGitDiff.tsx
git commit -m "feat(web): create and push tags from the Git page"
```

---

## 范围边界（明确不做）

- **不**支持在任意历史 commit 上创建 tag —— 统一在 **HEAD** 创建（需求只说"新建 tag"；如需指定 commit 是后续增量）
- **不**支持删除本地/远程 tag
- **不**支持拉取远程 tag 到本地
- **不**修既有 `git/commit`、`git/push` 的命令注入（另行报告，不擅自扩大改动）
- **不**用 `--force`，不提供强制覆盖入口

---

## Self-Review 记录

- **Spec 覆盖**：创建 ✓(A6,B4) / 逐个推送 ✓(A8,B5) / 一键全部 ✓(A8,B6) / 未推送状态 ✓(A7,B3,B5) / remote 交给 git 解析 ✓(A2) / 不覆盖 ✓(A8 无 force + 测试 10)
- **占位符扫描**：无 TBD；关键代码与命令均给出
- **类型一致性**：`sha` / `annotated` / `pushed` / `remote_ok` / `unpushed` 在契约、Task A、Task B 中命名一致
- **关键依赖已实测验证**：`^{}` 过滤、`%(objectname)` 口径、refspec 必须带 remote、execFileSync 无 shell 注入

## 待用户确认的一个技术偏差

决策 4「不指定 remote」在 tag refspec 场景下**技术上不可行**（实测 `git push refs/tags/x` 因 git 把第一个参数当 repository 而失败）。计划改为「用 git 解析出 remote 名再显式传入」。已在上方标注，需用户确认。

---

## 实施后的修订（与初版计划的差异）

### 1. remote 解析优先级改为与 git 完全一致（初版计划写错了）

初版计划写的是 `branch.<cur>.remote` → `remote.pushDefault` → 第一个 remote。**这个顺序是错的**：git push 的真实优先级是

`branch.<cur>.pushRemote` → `remote.pushDefault` → `branch.<cur>.remote` → 回退。

实测（3 个 bare remote）：`branch.main.remote=r1` + `remote.pushDefault=r2` 时 `git push --tags` 落到 **r2**，而初版实现会返回 r1；再加上 `branch.main.pushRemote=r3` 时 git 落到 **r3**。后果是 fork 工作流下 tag 被静默推到非预期仓库。现已按 git 语义实现，并补了 4 条优先级测试（每条都断言 tag 真的落到目标 bare 仓库、其他 bare 仓库没有它）。

### 2. `sha` 字段不再从 `|||` 格式串取

初版把 `%(objectname)` 追加在 `%(subject)` 之后，导致 subject 含 `|||` 时错位 —— 实测 annotated message 为 `subject with ||| inside` 时接口返回 `{"subject":"subject with","sha":"inside"}`，sha 变垃圾值，前端 `isUnpushed` 恒为 true，「未推送」徽标**永久误报**。现已从 format 串去掉 `%(objectname)`，改用已有的 tab 分隔 `listLocalTagShas()` 按 name 合并。依据（实测）：ref 名**不允许含 tab**（`git check-ref-format` 拒绝），故 tab 分隔解析对 name/sha 安全。

### 3. 额外修复：既有 shell 命令注入（用户批准扩大范围）

`execGit()` 用 `execSync` 拼接命令，`git/commit` 的 message 与 `user.name`/`userEmail`、`git/push` 的 extraheader 均存在**真实命令注入**。实测：message 为 `fix $(touch /tmp/PWNED) issue` 时 `touch` 确实被执行。现已全部改为 `execFileSync` argv 形式（不经 shell），并补回归测试。

实施后独立审计了剩余全部 shell 调用点：仅 hash（正则校验）、ref 名（正则校验）、limit（`Number()`）三处入参动态，均无自由文本。

**额外发现（供后续参考）**：git 分支名**允许** `$(...)`、反引号、分号、管道、`>`、`"`（仅空格被拒），实测 `git checkout -b 'a$(x)'` 可成功创建。因此任何把分支名拼进 shell 的写法都极其危险；本功能的 `resolveGitRemote` 已用 argv 形式，实测恶意分支名无法执行命令。

---

## 已知边界（reviewer 确认可接受，无数据风险）

1. **tag 名含 `|||`** 时，name 在 `|||` 元数据格式里仍会错位（git 允许 ref 名含 `|`）。此时 sha 可能为空字符串 → 前端该行显示「未推送」且点击会得到 git 报错。属既有歧义，本次只保证 sha 不再被 message 片段污染。
2. **无任何 push remote 配置时**回退到 `git remote` 的第一个（而 git 本身会报 `No configured push destination`）。这是刻意设计 —— 否则 `/git/remote-tags` 无法工作，只能永远 remote_ok:false。
3. **批量推送部分成功**时契约固定返回 `pushed: []`，UI 会提示失败但可能有部分 tag 已落地。属已冻结契约。
4. **前端新逻辑无单测**（`isUnpushed` / 一键 N / 创建并推送），契约靠人工审查与端到端探针验证。
5. subject 含 `|||` 时 subject 字段本身只取第一段（既有歧义，未在本次处理）。

