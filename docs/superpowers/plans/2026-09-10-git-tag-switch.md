# Git 页面 Tag 切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Git 页面现有分支选择器上增加 branch/tag 模式切换，支持检出 tag（detached HEAD），worktree 处理逻辑零改动。

**Architecture:** 后端新增 `GET .../git/tags` 端点、扩展 `POST .../git/checkout` 接受 `type: 'branch'|'tag'`，并新增 detached HEAD 探测（`git symbolic-ref -q HEAD`）；前端在既有下拉内加分段切换按钮 Branch|Tag，复用原有 branch 列表渲染，tag 列表另起一个分支渲染，detached 状态用新增徽标提示。

**Tech Stack:** Bun + Hono + Drizzle（api）、React + TanStack Query + Tailwind（web）、bun:test

**Worktree:** `/home/bighu/server/piplus/.worktrees/git-tag-switch`（分支 `feat/git-tag-switch`）

---

## 用户已确认的决策（不可偏离）

1. **detached 策略**：允许 detached；UI 显示独立「detached @ <tag>」徽标 + 选择器高亮当前 tag
2. **选择器形态**：分段切换按钮 `Branch | Tag` + 下方同一个下拉，切换模式换列表内容
3. **有本地改动时**：直接展示 git stderr 报错，沿用现有 `opFeedback` 红字，不做预检/force/stash
4. **DTO 策略**：沿用 `/tmp` 内联风格 —— 在 `api.ts` 内联声明 tags 响应类型，**不动** `packages/shared/src/dto.ts`
5. **测试**：新建 `apps/api/src/routes/sessions/git.test.ts`，真实临时 git 仓库
6. **隔离**：`/home/bighu/server/piplus/.worktrees/git-tag-switch`

---

## 调研得到的关键事实（已实测验证，git 2.47.3）

| 事实 | 验证结果 |
|---|---|
| `git tag --list --sort=-creatordate --format='%(refname:short)\|\|\|%(objecttype)\|\|\|%(creatordate:short)\|\|\|%(subject)'` | 可用。annotated tag → `objecttype=tag`，lightweight → `commit` |
| `git tag --points-at HEAD` | 可用，且能返回**所有**指向 HEAD 的 tag（`describe --exact-match` 只能返回一个，会漏） |
| 分支与 tag 同名时 `git checkout v1` | **切到分支**（`heads/v1`）并警告 "refname 'v1' is ambiguous" → tag 必须用全名 `refs/tags/<name>` |
| `git checkout refs/tags/v1` | 正确 detached，且以 `refs/` 开头永不被当成选项解析 |
| `git symbolic-ref -q HEAD` | 在分支上输出 `refs/heads/dev`；detached 时非 0 退出 → 最可靠的 detached 判定 |
| `git tag -- -f` | `fatal: '-f' is not a valid tag name.`（git CLI 拒绝以 `-` 开头的 tag） |
| detached 时 `rev-parse --abbrev-ref HEAD` | 返回字符串 `HEAD` → 现有 `is_current` 判定会失真，故必须新增显式 detached 字段 |

**基线测试状态（改动前，worktree 与主仓完全一致）：**
- `bun test` → `316 pass / 55 fail / 2 errors`，Ran 371 tests
- 55 个失败是**环境性预存在的**（缺 .env / 外部依赖），本计划不得引入**新增**失败。交付标准：pass 数 = 316 + 新增测试数，fail 数仍为 55。

---

## 冻结区（字节级禁止改动）

**后端 `apps/api/src/routes/sessions/routes/git.ts`**
- `git/branches` 内 L187-209（worktree list 解析）、L211-218（`is_worktree` / `worktree_path` / `session_worktree_path` 注入）
- `git/checkout` 内 L386-419（worktree 判定循环 + `worktreePath` DB 写入 + 清空逻辑）

**前端 `apps/web/src/components/TabGitDiff.tsx`**
- L474-478（trigger 内 W 徽标 vs GitBranch 图标三元表达式）
- L490（`const isWorktreeBranch = b.is_worktree;`）
- L522-537（branch 行的 amber 样式 + worktree 路径尾名）
- L659-664（`{sessionWorktreePath && ...}` worktree badge）

**规则：允许在其前后「新增」元素/字段，禁止修改块内任何一行。**

---

## API 契约（并行开发的冻结接口，两个 worker 必须严格遵守）

### 1. `GET /api/v1/sessions/:sessionId/git/tags`（新增）

```json
{
  "session_id": "s1",
  "cwd": "/path/to/repo",
  "detached": false,
  "tags": [
    { "name": "v2.0.0", "is_current": false, "is_annotated": true, "date": "2026-09-10", "subject": "release 2.0" },
    { "name": "v1.0.0", "is_current": false, "is_annotated": false, "date": "2026-09-01", "subject": "first commit" }
  ]
}
```

- 命令：`git tag --list --sort=-creatordate --format='%(refname:short)|||%(objecttype)|||%(creatordate:short)|||%(subject)'`
- `is_annotated` = `objecttype === 'tag'`
- `is_current` = `detached === true && name ∈ (git tag --points-at HEAD)`
- 错误：会话不存在 → 404 `{ error: { code: 'NOT_FOUND', message: 'Session not found' } }`；git 失败 → 500 `{ error: { code: 'GIT_ERROR', message } }`

### 2. `GET .../git/branches`（扩展，现有字段值不变）

新增 3 个顶层字段，其余字段与现有响应**逐字节等价**：
```json
{ "detached": true, "detached_ref": "v0.2.1" }
```
- `detached` = `git symbolic-ref -q HEAD` 非 0 退出
- `detached_ref` = `git tag --points-at HEAD` 的第一行；无 tag 则 `git rev-parse --short HEAD`；**未 detached 时为 `null`**

### 3. `POST .../git/checkout`（扩展）

请求体（向后兼容）：
```json
{ "ref": "v2.0.0", "type": "tag" }
```
- `ref` 优先；`ref` 缺失时回落到旧字段 `branch`（向后兼容）
- `type` 仅 `'tag'` 有意义，其余一律当 `'branch'`
- 校验：trim 后非空；匹配 `/^[a-zA-Z0-9._\-/]+$/`；**新增**：不得以 `-` 开头（`git checkout "-f"` 会被 git 当成 `-f` 强制丢弃本地改动，属实测数据丢失风险）
- `type === 'tag'` → 执行 `git checkout refs/tags/<name>`（全名 → 与同名分支消歧义、保证 detached、杜绝选项解析）
- `type === 'branch'` → 保持现状 `git checkout "<name>"`（含 worktree 判定路径）
- **响应结构完全不变**：`{ session_id, cwd, result, stdout?|stderr?, branch }`（前端靠 invalidate 重新读状态，不需要额外字段；且 worktree 早返回语句在冻结区内无法改）

### 4. 前端类型契约

```ts
// api.ts
export type GitRefType = 'branch' | 'tag';

export function getGitTags(sessionId: string): Promise<{
  session_id: string; cwd: string; detached: boolean;
  tags: Array<{ name: string; is_current: boolean; is_annotated: boolean; date: string; subject: string }>;
}>;

export function gitCheckout(sessionId: string, ref: string, type: GitRefType = 'branch'); // body { ref, type }

// getGitBranches 返回类型追加： detached: boolean; detached_ref: string | null

// hooks.ts
export function useGitTags(sessionId: string | null); // queryKey ['session','git-tags',sessionId], staleTime 10_000
export function useGitCheckoutMutation(); // mutationFn 参数 { sessionId, ref, type? }
// onSuccess 需 invalidate： git-branches / git-tags / git-diff / git-commits
```

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `apps/api/src/routes/sessions/routes/git.ts` | tags 端点、detached 探测、checkout 扩展 | Modify |
| `apps/api/src/routes/sessions/git.test.ts` | git 路由测试（真实临时 git 仓库） | Create |
| `apps/web/src/lib/api.ts` | getGitTags、gitCheckout(type)、branches 类型扩展 | Modify |
| `apps/web/src/lib/hooks.ts` | useGitTags、useGitCheckoutMutation 扩展 | Modify |
| `apps/web/src/components/TabGitDiff.tsx` | 分段切换 UI、tag 列表、detached 徽标 | Modify |

**并行切分（零文件重叠）：**
- Worker A = 后端两文件
- Worker B = 前端三文件

---

### Task A: 后端 tags 端点 + detached 探测 + checkout 扩展

**Files:**
- Modify: `apps/api/src/routes/sessions/routes/git.ts`
- Create: `apps/api/src/routes/sessions/git.test.ts`

- [ ] **Step A1: 写失败测试**

新建 `apps/api/src/routes/sessions/git.test.ts`。沿用 `apps/api/src/routes/files.test.ts` 的样板：`createSeedDb` + `Bun.env.DATABASE_URL` + `createApp()` + `POST /api/v1/projects {mode:'existing', path}` 拿 sessionId，请求头 `x-user-id: user_seed`。

测试内用 `Bun.spawnSync` / `execSync` 在临时目录建真实 git 仓库并 `git config user.email/user.name`，否则 commit 会失败。

必须覆盖以下 8 个用例：

1. `git/tags` 返回 annotated 与 lightweight 两类 tag，`is_annotated` 分别 true/false
2. `git/tags` 在未 detached 时所有 `is_current === false`
3. `git/tags` 在 checkout 到 tag 后，该 tag `is_current === true`，`detached === true`
4. CHECKOUT 到 tag：`POST git/checkout {ref, type:'tag'}` 返回 200，仓库进入 detached 状态
5. CHECKOUT 到 tag 后 `git/tags` 的 `is_current` 高亮正确（多 tag 指向同一 commit 时全部高亮）
6. `git/branches` detached 时 `detached === true` 且 `detached_ref` 为 tag 名；未 detached 时 `detached === false` 且 `detached_ref === null`
7. 校验失败：空 ref → 400 `EMPTY_REF`；`-f` → 400 `INVALID_BRANCH`；`bad name!` → 400
8. worktree 回归：为某分支建 worktree 后，该分支在 `git/branches` 里 `is_worktree === true` 且 `worktree_path` 非空、`is_current === false`；checkout 该分支返回的 `cwd` 等于 worktree 路径；切回主分支后 `worktree_path` 被清空（`session_worktree_path === null`）；且 tag 模式下写 `session.worktreePath` 的逻辑不被触发

- [ ] **Step A2: 跑测试确认失败**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch && bun test apps/api/src/routes/sessions/git.test.ts
```
Expected: 大量 FAIL（`GET .../git/tags` 目前 404）

- [ ] **Step A3: 实现 helper（模块作用域新增，不改动现有函数）**

在 `git.ts` 模块作用域（`registerGitRoutes` 之外）新增：

```ts
function isDetachedHead(cwd: string): boolean {
  try {
    execGit(cwd, 'symbolic-ref -q HEAD');
    return false;
  } catch {
    return true;
  }
}

function tagsPointingAtHead(cwd: string): string[] {
  try {
    return execGit(cwd, 'tag --points-at HEAD').split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function shortHeadSha(cwd: string): string | null {
  try {
    return execGit(cwd, 'rev-parse --short HEAD').trim() || null;
  } catch {
    return null;
  }
}
```

- [ ] **Step A4: 实现 tags 端点**

在 `git/branches` 端点之后新增 `GET /api/v1/sessions/:sessionId/git/tags`（带 swagger 注释块，风格与现有端点一致）：
- `resolveProjectDir(c, userId, sessionId)`，`'error' in resolved` 时照现有写法返回
- `const detached = isDetachedHead(cwd);`
- `const pointingAtHead = new Set(detached ? tagsPointingAtHead(cwd) : []);`
- 解析 `git tag --list --sort=-creatordate --format='%(refname:short)|||%(objecttype)|||%(creatordate:short)|||%(subject)'`，按 `|||` 切 4 段；`is_annotated = objecttype === 'tag'`；`is_current = pointingAtHead.has(name)`
- 返回上述契约 JSON；`catch` 照现有风格返回 500 `GIT_ERROR`

- [ ] **Step A5: 扩展 branches 端点（仅新增字段，冻结区一行不动）**

在 `git/branches` 的 `return c.json({...})` 里**追加**字段（不改动 `annotatedBranches` 表达式与 worktree 相关表达式）：
```ts
detached: isDetachedHead(cwd),
detached_ref: isDetachedHead(cwd) ? (tagsPointingAtHead(cwd)[0] ?? shortHeadSha(cwd)) : null,
```
（可先 `const detached = isDetachedHead(cwd);` 复用，避免重复执行 git）
必须确认 worktree list 解析块与 `annotatedBranches` 映射块**逐字节未变**。

- [ ] **Step A6: 扩展 checkout 端点**

- 读取 ref：`const rawRef = String((body as any).ref ?? (body as any).branch ?? '').trim();`
- `const refType: 'branch' | 'tag' = (body as any).type === 'tag' ? 'tag' : 'branch';`
- 空值 → `400 { error: { code: 'EMPTY_REF', message: 'Ref name is required' } }`
- 格式校验保留 `/^[a-zA-Z0-9._\-/]+$/` → `400 INVALID_BRANCH`，并**新增** `rawRef.startsWith('-')` → `400 INVALID_BRANCH`
- 【冻结区】worktree 判定循环：**用 `if (refType === 'branch') { ... }` 包裹**，块内每一行逐字节不动。tag 模式下 `worktreePath` 保持 `null`，从而自然落入既有的「清空 worktreePath + 主目录 checkout」分支，满足用户决策（从 detached 切回分支时清空逻辑必须仍然执行）
- 执行命令：
  - tag → `execGit(mainCwd, `checkout refs/tags/${rawRef}`)`（`refs/tags/` 前缀来自校验后的名字，不含 shell 特殊字符；正则已排除 `$`、反引号、`"`、`\`）
  - branch → `execGit(mainCwd, `checkout "${rawRef.replace(/"/g, '\\"')}"`)`（保持现状）
- 响应保持 `{ session_id, cwd, result, stdout: stdout.trim(), branch: rawRef }`

- [ ] **Step A7: 跑测试确认通过**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch && bun test apps/api/src/routes/sessions/git.test.ts
```
Expected: 全部 PASS

- [ ] **Step A8: 全量回归 + typecheck**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch && bun test 2>&1 | tail -5
cd /home/bighu/server/piplus/.worktrees/git-tag-switch/apps/api && bun run typecheck
```
Expected: `bun test` = `316+新增` pass / **55 fail**（与基线一致，不得新增失败）/ 2 errors；typecheck 无错

- [ ] **Step A9: 提交**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch
git add apps/api/src/routes/sessions/routes/git.ts apps/api/src/routes/sessions/git.test.ts
git commit -m "feat(api): add git tags endpoint, detached HEAD detection, tag checkout"
```

---

### Task B: 前端 api/hooks + 选择器 UI

**Files:**
- Modify: `apps/web/src/lib/api.ts:369-378`
- Modify: `apps/web/src/lib/hooks.ts:35-38,502-522`
- Modify: `apps/web/src/components/TabGitDiff.tsx`

- [ ] **Step B1: api.ts**

- `getGitBranches` 返回类型追加 `detached: boolean; detached_ref: string | null`
- 新增 `export type GitRefType = 'branch' | 'tag';`
- 新增 `getGitTags(sessionId)` → `GET /api/v1/sessions/${sessionId}/git/tags`，返回类型见契约
- `gitCheckout(sessionId, ref, type: GitRefType = 'branch')` → body `JSON.stringify({ ref, type })`

- [ ] **Step B2: hooks.ts**

- import 加入 `getGitTags`
- 新增 `useGitTags(sessionId)`：`queryKey: ['session','git-tags',sessionId]`，`enabled: Boolean(sessionId)`，`staleTime: 10_000`
- `useGitCheckoutMutation`：mutationFn 签名改为 `({ sessionId, ref, type }: { sessionId: string; ref: string; type?: GitRefType })` → `gitCheckout(sessionId, ref, type ?? 'branch')`；`onSuccess` 在现有 3 个 invalidate 之外**追加** `git-tags`

- [ ] **Step B3: TabGitDiff.tsx — 状态与数据**

- import 加入 `useGitTags`，lucide 加入 `Tag`
- 第 261 行附近新增 `const [refMode, setRefMode] = useState<'branch' | 'tag'>('branch');`
- 第 227 行附近新增 `const gitTagsQuery = useGitTags(activeTab === 'diff' ? selectedSessionId : null);`
- 第 446 行附近新增派生值：
  ```ts
  const detached = gitBranchesQuery.data?.detached ?? false;
  const detachedRef = gitBranchesQuery.data?.detached_ref ?? null;
  const tags = gitTagsQuery.data?.tags ?? null;
  ```
- **`anyBusy`（L454）一行不动**

- [ ] **Step B4: TabGitDiff.tsx — trigger 标签（不下沉到冻结区）**

- L479 的 `<span>{currentBranch || '—'}</span>` 改为：detached 时渲染
  `<Tag className="w-3 h-3 shrink-0 text-violet-500" />` + `detached @ {detachedRef || currentBranch || 'HEAD'}`，否则维持 `{currentBranch || '—'}`
- L474-478 的 W 徽标 / GitBranch 图标三元表达式**一行不动**

- [ ] **Step B5: TabGitDiff.tsx — 分段切换 + tag 列表**

- L485-488 静态标题 `分支 (N)` 替换为分段控件：两个 button（`分支 (branches?.length ?? 0)` / `标签 (tags?.length ?? 0)`），`onClick` 设 `setRefMode`；选中态用蓝色高亮，未选中用 slate
- L489 的 `<div className="max-h-60 overflow-y-auto">` 内部改为 `{refMode === 'branch' ? (<>{原有 branches?.map(...) 整块</>) : (<>{tags?.map(...) 新 tag 行</>)}`
  - **branch 分支整块逐字节保持原样**，含 L490 `const isWorktreeBranch = b.is_worktree;` 与 L522-537 amber 样式/W 徽标/路径尾名
  - branch 模式点击回调改为 `gitCheckoutMut.mutateAsync({ sessionId: selectedSessionId!, ref: b.name, type: 'branch' })`（仅参数名 `branch`→`ref` + 加 `type`，其余逻辑/文案不变）
  - tag 行：`is_current` 高亮（同 branch 当前态样式）+ 右侧「当前」；annotated 显示一个 `Tag` 图标标记与 `t.is_annotated` 相关的小徽标；左侧展示 `t.name`（truncate）、副行展示 `t.date` 与 `t.subject`（truncate）；`disabled={t.is_current || isCheckingOut}`
  - tag 点击：`gitCheckoutMut.mutateAsync({ sessionId: selectedSessionId!, ref: t.name, type: 'tag' })`，成功 toast `已切换到标签 "<name>"（detached HEAD）`，失败用 `res.stderr`；catch 文案 `切换到标签 "<name>" 失败`；沿用 `setTimeout(clearFeedback, 6000)`
  - 空态：无 tag → `无标签`；`!tags` → `加载中…`
- `setRefMode('branch')` 在切换会话/`selectedSessionId` 变化时重置：`useEffect(() => { setRefMode('branch'); }, [selectedSessionId]);`

- [ ] **Step B6: TabGitDiff.tsx — detached 徽标（新增，不碰冻结 badge）**

- L659-664 的 `{sessionWorktreePath && (...)}` worktree badge **一行不动**；在其**之后**新增兄弟节点：
  ```jsx
  {detached && (
    <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-bold bg-violet-100 dark:bg-violet-900/40 text-violet-700 dark:text-violet-300 leading-none">
      <Tag className="w-2.5 h-2.5" />
      <span>detached{detachedRef ? ` @ ${detachedRef}` : ''}</span>
    </span>
  )}
  ```

- [ ] **Step B7: 验证**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch/apps/web && bun run lint
cd /home/bighu/server/piplus/.worktrees/git-tag-switch && bun run test:web 2>&1 | tail -5
```
Expected: lint 无错；test:web 与基线一致

- [ ] **Step B8: 冻结区自检**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch && git diff -U0 apps/web/src/components/TabGitDiff.tsx | grep -n "^-" | grep -v "^---" 
```
Expected: 删除行只应出现在 `branchDropdownOpen` 头部标题、`<span>{currentBranch …}</span>`、checkout 调用参数名这几处；**不得**出现 L474-478 / L490 / L522-537 / L659-664 相关的删除行

- [ ] **Step B9: 提交**

```bash
cd /home/bighu/server/piplus/.worktrees/git-tag-switch
git add apps/web/src/lib/api.ts apps/web/src/lib/hooks.ts apps/web/src/components/TabGitDiff.tsx
git commit -m "feat(web): add branch/tag mode switch and tag checkout in Git page"
```

---

## Self-Review 记录

- **Spec 覆盖**：tag 端点 ✓(A4) / checkout 到 tag ✓(A6) / detached 识别 ✓(A3,A5) / UI 模式切换 ✓(B5) / detached 徽标+高亮 ✓(B4,B6) / worktree 冻结 ✓(A6,B5,B8) / 测试 ✓(A1) / 内联 DTO ✓(B1)
- **占位符扫描**：无 TBD/TODO；所有代码步骤均给出实际命令与代码片段
- **类型一致性**：`ref` / `type` / `detached` / `detached_ref` / `is_current` / `is_annotated` 在契约、Task A、Task B 中命名一致
- **风险**：`refMode` 切换时 `branchSelectorRef` 的外部点击关闭逻辑（L287-297）不需改动，分段控件在 `branchSelectorRef` 容器内，点击不会误关

---

## 实施后的修订（与初版计划的差异）

初版计划中 `git tag --list` 使用 `%(refname:short)`。实测发现**同名 branch+tag 存在时**它会消歧义输出 `tags/v1.0.0`，与 `git tag --points-at HEAD` 的 `v1.0.0` 口径错位，导致当前 tag 不高亮、点选必然 500。已改为 `%(refname:lstrip=2)`（两侧同步对齐）。新增了走完整 `GET /git/tags` → 用列表返回的 name 调 checkout 的端到端测试。

同时修复：checkout 失败时 500 响应体缺少 `error` 字段，导致前端 `request()` 抛出通用错误、git stderr 无法上屏（违反「直接展示 git stderr」的决策）。现追加 `error: { code: 'CHECKOUT_FAILED', message: stderr }`。

另外新增一行过滤：detached HEAD 时 `git branch --format` 会输出形如 `(HEAD detached at v1.0.0)` 的伪分支条目，现将其从分支列表中剔除。该行位于 worktree list 解析块**之前**，未触碰任何冻结区。

---

## 已知问题（预存在，本次未修）

**同名 branch+tag 时，分支侧 checkout 会静默变成 detached HEAD。**

- 现象：仓库同时存在 branch `v1.0.0` 与 tag `v1.0.0` 时，`git branch --format='%(refname:short)'` 把该分支渲染为 `heads/v1.0.0`；分支模式 checkout 执行 `git checkout "heads/v1.0.0"`，git 将其当作 ref 后缀形式的 commit-ish 解析，于是**只 detach、不挂到分支**。UI 会提示「已切换到分支」但实际进入 detached 状态。
- 性质：**改动前即存在**（`branch --format` 那一行与 base 逐字节相同），非本次引入；本次 tag 功能仅采用了同样的修复思路，未扩大影响面。
- 为什么没有顺手修：正确修法需要把分支列表也改成 `%(refname:lstrip=2)`，但**实测 `git worktree list` 在同名场景输出 `[heads/v1.0.0]`，与当前分支列表键恰好一致**，因此 worktree 徽标现在是正常工作的。一旦只改分支列表，两侧键就会错位，**会直接破坏 worktree 匹配**（is_worktree / worktree_path 注入）。要正确修必须同时改冻结区的 worktree 解析，属于独立改动。
- 建议：另开分支，把「分支列表命名」与「worktree list 分支名解析」作为一个整体一起规范化，并补充同名场景的 worktree 回归测试。

