# 免登录模式（APP_PASSWORD 开关）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** APP_PASSWORD 未设置时 API 免登录、前端跳过登录页直接进入；设置后恢复现状登录流程。

**Architecture:** 后端在 `apps/api/src/auth/token.ts` 新增 `isAuthEnabled()`（显式设置非空 APP_PASSWORD → 需登录）。`requireAuth` 与 WS 握手按「token → x-user-id → 免登录放行 → 401」顺序判定。新增公开路由 `GET /api/v1/auth/status` 返回 `{ requiresPassword }`。前端新增 `useAuthStatus` hook，`isLoggedIn` 变为「免登录模式 或 token 有效」。

**Tech Stack:** Hono (Bun), React + TanStack Query, bun:test

**契约（两个 worker 共同遵守）:**
- `GET /api/v1/auth/status` → `200 { requiresPassword: boolean }`（公开，无需认证）
- 免登录模式定义：`getServerConfig().appPassword` 为 `undefined` 或 `''`
- requireAuth 顺序：① Bearer/`?token=` 有效 → `local-user`；② `x-user-id` header（非 production）→ 该用户；③ 免登录模式 → `local-user`；④ 否则 401
- 默认密码 `piplus-local`（token.ts DEFAULT_PASSWORD）保持不变；login/check 路由行为不变

---

## Task 1: 后端 —— isAuthEnabled + requireAuth 免登录 + auth/status 路由

**Files:**
- Modify: `apps/api/src/auth/token.ts`
- Modify: `apps/api/src/middleware/auth.ts`
- Modify: `apps/api/src/auth/routes.ts`
- Modify: `apps/api/src/ws/server.ts`
- Test: `apps/api/src/routes/auth-status.test.ts`（新建）
- Test: `apps/api/src/routes/projects.test.ts:15-31`
- Test: `apps/api/src/routes/tree-info.test.ts:16-23, 75-81`
- Test: `apps/api/src/routes/sessions.test.ts:41-51, 746-755, 846-856`

- [ ] **Step 1: token.ts 新增 isAuthEnabled**

```ts
// apps/api/src/auth/token.ts — 在 getAppPassword() 后新增
export function isAuthEnabled(): boolean {
  const password = getServerConfig().appPassword;
  return password !== undefined && password !== '';
}
```

- [ ] **Step 2: requireAuth 插入免登录放行（token 与 x-user-id 之后、401 之前）**

```ts
// apps/api/src/middleware/auth.ts — import 加 isAuthEnabled；在 headerUserId 分支后、return 401 前插入：
  // No-auth mode: when APP_PASSWORD is not explicitly set, allow anonymous access
  if (!isAuthEnabled()) {
    c.set('userId', 'local-user');
    c.set('userName', 'Piplus');
    return await next();
  }
```

- [ ] **Step 3: auth/routes.ts 新增 GET /api/v1/auth/status**

```ts
// import 加 isAuthEnabled；在 registerAuthRoutes 内 /api/v1/auth/check 之前（或之后）新增：
  /**
   * @swagger
   * /api/v1/auth/status:
   *   get:
   *     summary: 查询是否启用密码登录
   *     tags: [Auth]
   *     description: 返回 requiresPassword 指示前端是否需要展示登录页。无需认证。
   *     responses:
   *       200:
   *         description: 认证模式。
   */
  app.get('/api/v1/auth/status', (c) => c.json({ requiresPassword: isAuthEnabled() }));
```

- [ ] **Step 4: ws/server.ts 免登录放行**

```ts
// apps/api/src/ws/server.ts — import 加 isAuthEnabled；onOpen 内 userId 计算改为：
      const userId = verifyToken(token) ? 'local-user' : c.req.header('x-user-id') ?? (isAuthEnabled() ? undefined : 'local-user');
```

- [ ] **Step 5: 新建 auth-status.test.ts**

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { createApp } from '../app';

describe('auth status', () => {
  const originalPassword = Bun.env.APP_PASSWORD;
  afterEach(() => {
    if (originalPassword === undefined) delete Bun.env.APP_PASSWORD;
    else Bun.env.APP_PASSWORD = originalPassword;
  });

  test('requiresPassword=false when APP_PASSWORD is unset', async () => {
    delete Bun.env.APP_PASSWORD;
    const app = createApp();
    const res = await app.request('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requiresPassword: false });
  });

  test('requiresPassword=true when APP_PASSWORD is set', async () => {
    Bun.env.APP_PASSWORD = 'test-secret';
    const app = createApp();
    const res = await app.request('/api/v1/auth/status');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ requiresPassword: true });
  });

  test('requireAuth allows anonymous access in no-auth mode', async () => {
    delete Bun.env.APP_PASSWORD;
    const app = createApp();
    const res = await app.request('/api/v1/tree');
    expect(res.status).toBe(200);
  });

  test('requireAuth rejects anonymous access when password auth is enabled', async () => {
    Bun.env.APP_PASSWORD = 'test-secret';
    const app = createApp();
    const res = await app.request('/api/v1/tree');
    expect(res.status).toBe(401);
  });
});
```

注意：bun test 单进程顺序执行所有文件，任何设置了 `Bun.env.APP_PASSWORD` 的测试必须在 `afterEach` 恢复原值（用 `originalPassword` 捕获 + 恢复模式，见上）。

- [ ] **Step 6: 修复现有 7 个"需认证"测试（它们断言 401，免登录模式下会变 200）**

模式：测试函数体内设置 `Bun.env.APP_PASSWORD = 'test-secret'`，结束后恢复。推荐在每个文件的 describe 顶部加一个文件级 helper：

```ts
// 每个受影响测试文件顶部（import 之后）：
function withPasswordAuth<T>(fn: () => T): T {
  const prev = Bun.env.APP_PASSWORD;
  Bun.env.APP_PASSWORD = 'test-secret';
  try { return fn(); } finally {
    if (prev === undefined) delete Bun.env.APP_PASSWORD; else Bun.env.APP_PASSWORD = prev;
  }
}
```

受影响测试（全部在 `createApp()` 调用前包裹 `withPasswordAuth(() => { ... })`，或等价地函数开头设值 + try/finally 恢复）：
1. `apps/api/src/routes/projects.test.ts` — `'create project requires authentication'`（约 L15-31）
2. `apps/api/src/routes/tree-info.test.ts` — `'tree requires authentication'`（L16-23）
3. `apps/api/src/routes/tree-info.test.ts` — `unauthenticatedRes` 断言（约 L75-81）
4. `apps/api/src/routes/sessions.test.ts` — `'chat message history requires authentication'`（约 L41-51）
5. `apps/api/src/routes/sessions.test.ts` — `'patch session title requires authentication'`（约 L746-755）
6. `apps/api/src/routes/sessions.test.ts` — `'POST /api/v1/sessions/:id/stop requires authentication'`（约 L846-856）

注意：这些测试函数内部已经是「设置 Bun.env.DATABASE_URL → createApp()」结构，把 APP_PASSWORD 设置加在 createApp() 之前即可。`withPasswordAuth` 同步调用即可（app.request 在包裹内同步发起，Promise 内部已拿到 401 响应——但保险起见把整个 async 测试体包进去，helper 返回值可以是 Promise：`function withPasswordAuth<T>(fn: () => T): T` 泛型直接透传，async fn 返回 Promise 也兼容）。

- [ ] **Step 7: 运行测试验证**

```bash
cd apps/api && bun test --timeout 60000
```
预期：全绿（新增 4 个 auth-status 测试 + 原有 103 个）。若某测试因 `Bun.env.APP_PASSWORD` 残留失败，检查是否所有设置点都有恢复。

- [ ] **Step 8: typecheck**

```bash
cd apps/api && bun run typecheck
```

- [ ] **Step 9: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): no-auth mode when APP_PASSWORD unset + GET /api/v1/auth/status"
```

---

## Task 2: 前端 —— useAuthStatus + 免登录跳过登录页

**Files:**
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/hooks.ts`
- Modify: `apps/web/src/App.tsx`
- Verify: `apps/web/src/App.test.ts`（预期无需改动，结构守卫形状不变）

- [ ] **Step 1: api.ts 新增 getAuthStatus**

```ts
// apps/web/src/lib/api.ts — 在 checkAuth 附近新增：
export function getAuthStatus() {
  return request<{ requiresPassword: boolean }>('/api/v1/auth/status');
}
```

- [ ] **Step 2: hooks.ts 新增 useAuthStatus + 改造 useAuthSession**

```ts
// useAuthSession 之前新增：
export function useAuthStatus() {
  return useQuery({
    queryKey: ['auth', 'status'],
    queryFn: getAuthStatus,
    retry: false,
    staleTime: 5 * 60_000,
  });
}

// useAuthSession 改为（保持函数签名与导出名不变）：
export function useAuthSession() {
  const statusQuery = useAuthStatus();
  const requiresPassword = statusQuery.data?.requiresPassword ?? true;
  return useQuery({
    queryKey: ['auth', 'session'],
    queryFn: async () => {
      if (!requiresPassword) return { ok: true as const, user: { id: 'local-user', name: 'Piplus' } };
      const token = localStorage.getItem('piplus_token');
      if (!token) return null;
      return checkAuth(token);
    },
    retry: false,
    staleTime: 5 * 60_000,
  });
}
```

注意：`statusQuery` 是 hook 内的无条件 hook 调用，符合 Rules of Hooks。`requiresPassword` 默认 `true`（status 加载中/失败 → 保持现状行为）。

- [ ] **Step 3: App.tsx 免登录判定**

```ts
// App.tsx 顶部 import 加 useAuthStatus（在现有 useAuthSession import 处）：
  useAuthStatus,

// App() 函数内（约 L149-150）改为：
  const authStatusQuery = useAuthStatus();
  const authQuery = useAuthSession();
  const isLoggedIn = authStatusQuery.data?.requiresPassword === false || Boolean(authQuery.data?.ok);
```

守卫 `if (!isLoggedIn) { return <LoginScreen .../> }` 保持不变（L677）。

- [ ] **Step 4: 验证 App.test.ts 仍通过**

```bash
cd apps/web && bun test
```
预期：39 pass。App.test.ts 只断言 `if (!isLoggedIn)` 守卫形状 + 守卫后无 hook 调用 —— 新代码保留该形状且新 hook 全部在守卫之前。

- [ ] **Step 5: typecheck（lint）**

```bash
cd apps/web && bun run lint
```

- [ ] **Step 6: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): skip login page when APP_PASSWORD unset (no-auth mode)"
```

---

## Task 3: 验证（跨端）

- [ ] **Step 1: 后端全量测试** — `cd apps/api && bun test --timeout 60000` 全绿
- [ ] **Step 2: 前端全量测试** — `cd apps/web && bun test` 全绿
- [ ] **Step 3: 手动验证（可选，dev 环境）**
  - 不设 APP_PASSWORD 启动 `apps/api` + `apps/web` dev → 直接进入应用无登录页
  - `curl http://localhost:3001/api/v1/auth/status` → `{"requiresPassword":false}`
  - 设 `APP_PASSWORD=xxx` 重启 → `curl .../auth/status` → `{"requiresPassword":true}`；无 token 请求 `/api/v1/tree` → 401；错误密码登录 → 401；`xxx` 登录 → 200 带 token

---

## Self-Review

**Spec coverage:**
- ✅ 后端免登录：Task 1 Step 1-2
- ✅ auth/status 路由：Task 1 Step 3
- ✅ WS 适配：Task 1 Step 4
- ✅ 后端测试（含现有 401 测试适配 + 新增）：Task 1 Step 5-6
- ✅ 前端登录态判断：Task 2 Step 2-3
- ✅ 请求适配（authHeaders 不变即适配——免登录模式无 token 也放行）：Task 2 无需改动 authHeaders
- ✅ App.test.ts：Task 2 Step 4 验证
- ✅ 登录页保留：不改 LoginScreen
- ✅ 桌面端：env 透传已有，无改动
- ✅ 不动 WS 广播/消息逻辑：只改 onOpen 的 userId 判定

**边界确认:**
- `APP_PASSWORD=''`（空字符串）→ 免登录（`isAuthEnabled` 返回 false）
- status 接口失败（API 不可达）→ 前端默认 requiresPassword=true → 显示登录页（安全默认，同现状）
- 免登录模式 + 残留旧 token → checkAuth 不调用（queryFn 提前返回 ok），无副作用
- login 接口在免登录模式仍可用（默认密码 piplus-local），向后兼容 API 客户端与 models.test.ts
