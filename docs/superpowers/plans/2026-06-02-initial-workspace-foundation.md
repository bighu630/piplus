# Initial Workspace Foundation 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 从零初始化同仓双应用 monorepo，并落地首版可运行骨架：本地种子账号认证、SQLite + Drizzle 核心数据模型、`apps/api` 公共 HTTP API 基线、WebSocket 实时通道基线、`apps/web` 左树 + Chat / Session Info 壳层，以及 `packages/db` / `packages/domain` / `packages/pi-client` / `packages/shared` / `packages/ui` 的基础结构。

**架构：** 采用 Bun workspaces 作为根工作区，`apps/api` 承担唯一后端真相与 API 边界，`apps/web` 只消费 API。领域逻辑下沉到 `packages/domain`，数据库 schema 与迁移集中在 `packages/db`，PI 适配封装在 `packages/pi-client`，共享 DTO/枚举/类型放在 `packages/shared`，UI 基础件放在 `packages/ui`。

**技术栈：** Bun、TypeScript、Next.js App Router、Hono、better-auth、SQLite、Drizzle ORM / Drizzle Kit、TanStack Query、Tailwind CSS、shadcn/ui、framer-motion。

---

### 任务 1：初始化 monorepo 与基础脚手架

**文件：**
- 创建：`package.json`
- 创建：`bunfig.toml`
- 创建：`tsconfig.base.json`
- 创建：`tsconfig.json`
- 创建：`.gitignore`
- 创建：`.env.example`
- 创建：`apps/web/package.json`
- 创建：`apps/web/tsconfig.json`
- 创建：`apps/web/next.config.ts`
- 创建：`apps/web/tailwind.config.ts`
- 创建：`apps/web/postcss.config.mjs`
- 创建：`apps/api/package.json`
- 创建：`apps/api/tsconfig.json`
- 创建：`packages/db/package.json`
- 创建：`packages/db/tsconfig.json`
- 创建：`packages/domain/package.json`
- 创建：`packages/domain/tsconfig.json`
- 创建：`packages/pi-client/package.json`
- 创建：`packages/pi-client/tsconfig.json`
- 创建：`packages/shared/package.json`
- 创建：`packages/shared/tsconfig.json`
- 创建：`packages/ui/package.json`
- 创建：`packages/ui/tsconfig.json`

- [ ] **步骤 1：编写工作区清单与根配置**

```json
{
  "name": "piplus",
  "private": true,
  "workspaces": ["apps/*", "packages/*"],
  "scripts": {
    "dev": "bun --cwd apps/web dev & bun --cwd apps/api dev",
    "dev:web": "bun --cwd apps/web dev",
    "dev:api": "bun --cwd apps/api dev",
    "typecheck": "bunx tsc -b",
    "test": "bun test"
  }
}
```

- [ ] **步骤 2：运行根级检查**

运行：`bun install && bun run typecheck`
预期：工作区被识别，类型检查阶段仅因后续业务代码未实现而报错，不能出现 workspace 配置或路径解析错误。

- [ ] **步骤 3：编写最少工作区入口**

```ts
// apps/api/src/index.ts
console.log("api boot");

// apps/web/app/page.tsx
export default function Page() {
  return <main>piplus</main>;
}
```

- [ ] **步骤 4：运行入口验证**

运行：`bun --cwd apps/api run src/index.ts` 与 `bun --cwd apps/web dev`
预期：两个应用都能启动到最小可访问状态。

- [ ] **步骤 5：Commit**

```bash
git add package.json bunfig.toml tsconfig*.json apps packages .env.example .gitignore
git commit -m "chore: bootstrap workspace foundation"
```

### 任务 2：建立 SQLite + Drizzle 核心数据模型与种子数据

**文件：**
- 创建：`packages/db/src/schema.ts`
- 创建：`packages/db/src/client.ts`
- 创建：`packages/db/src/index.ts`
- 创建：`packages/db/drizzle.config.ts`
- 创建：`packages/db/migrations/0001_initial.sql`
- 创建：`packages/db/seed.ts`
- 修改：`packages/db/package.json`
- 修改：`packages/domain/src/index.ts`
- 创建：`packages/shared/src/enums.ts`
- 创建：`packages/shared/src/dto.ts`

- [ ] **步骤 1：编写失败的 schema 测试**

```ts
import { expect, test } from "bun:test";
import { schema } from "@piplus/db";

test("core tables exist", () => {
  expect(schema.users).toBeDefined();
  expect(schema.sessions).toBeDefined();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/db`
预期：初始失败，原因是 schema 与导出尚未建立。

- [ ] **步骤 3：实现最小 schema**

```ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
```

- [ ] **步骤 4：运行 schema 验证**

运行：`bun test packages/db`
预期：schema 导出可用，测试通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/db packages/shared packages/domain
git commit -m "feat: add sqlite drizzle schema foundation"
```

### 任务 3：实现本地认证基础与种子账号登录

**文件：**
- 创建：`apps/api/src/auth/auth.ts`
- 创建：`apps/api/src/auth/routes.ts`
- 创建：`apps/api/src/auth/session.ts`
- 创建：`apps/api/src/middleware/auth.ts`
- 创建：`packages/domain/src/auth/service.ts`
- 创建：`packages/domain/src/auth/types.ts`
- 创建：`packages/db/src/auth.ts`

- [ ] **步骤 1：编写登录失败测试**

```ts
import { expect, test } from "bun:test";
import { authenticateSeedUser } from "@piplus/domain/auth/service";

test("rejects wrong password", async () => {
  await expect(authenticateSeedUser("seed@local", "bad")).rejects.toThrow();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/domain`
预期：认证服务尚未实现导致失败。

- [ ] **步骤 3：实现最少认证逻辑**

```ts
export async function authenticateSeedUser(email: string, password: string) {
  if (email !== "seed@local" || password !== "seed123") throw new Error("invalid_credentials");
  return { userId: "user_seed" };
}
```

- [ ] **步骤 4：运行认证测试**

运行：`bun test packages/domain`
预期：认证测试通过，且 API 侧可以通过 cookie/session 读取当前用户。

- [ ] **步骤 5：Commit**

```bash
git add apps/api packages/domain packages/db
git commit -m "feat: add local auth baseline"
```

### 任务 4：落地 `apps/api` 公开 HTTP API 基线与错误格式

**文件：**
- 创建：`apps/api/src/app.ts`
- 创建：`apps/api/src/routes/tree.ts`
- 创建：`apps/api/src/routes/projects.ts`
- 创建：`apps/api/src/routes/sessions.ts`
- 创建：`apps/api/src/lib/http-error.ts`
- 创建：`apps/api/src/lib/response.ts`
- 创建：`packages/shared/src/api.ts`

- [ ] **步骤 1：编写接口契约测试**

```ts
import { expect, test } from "bun:test";
import { createApp } from "@piplus/api/app";

test("GET /api/v1/tree returns tree envelope", async () => {
  const res = await createApp().request("/api/v1/tree");
  expect(res.status).toBe(200);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test apps/api`
预期：应用工厂与路由尚未实现。

- [ ] **步骤 3：实现最少路由**

```ts
app.get("/api/v1/tree", (c) => c.json({ projects: [] }));
```

- [ ] **步骤 4：运行 API 契约测试**

运行：`bun test apps/api`
预期：公开 API 可返回稳定 JSON，错误统一走 `error.code/message/details`。

- [ ] **步骤 5：Commit**

```bash
git add apps/api packages/shared
git commit -m "feat: add public api baseline"
```

### 任务 5：实现 WebSocket 基线与上下文订阅

**文件：**
- 创建：`apps/api/src/ws/server.ts`
- 创建：`apps/api/src/ws/protocol.ts`
- 创建：`apps/api/src/ws/session.ts`
- 创建：`apps/web/src/lib/ws-client.ts`
- 创建：`packages/shared/src/ws.ts`

- [ ] **步骤 1：编写协议测试**

```ts
import { expect, test } from "bun:test";
import { isClientMessage } from "@piplus/shared/ws";

test("accepts set_context", () => {
  expect(isClientMessage({ kind: "client", type: "set_context", payload: {} })).toBe(true);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/shared`
预期：协议 helpers 尚未实现。

- [ ] **步骤 3：实现最少 WS 协议**

```ts
export function isClientMessage(message: unknown) {
  return Boolean(message && typeof message === "object");
}
```

- [ ] **步骤 4：验证 WS 连接**

运行：`bun --cwd apps/api dev` 后用简单客户端连通 `hello` / `set_context` / `ping`。
预期：服务端可识别 `kind=event` 与 `kind=chat_stream` 两类下行帧。

- [ ] **步骤 5：Commit**

```bash
git add apps/api apps/web packages/shared
git commit -m "feat: add websocket baseline"
```

### 任务 6：实现角色管理层、项目管理层与 PI 适配层骨架

**文件：**
- 创建：`packages/domain/src/project/service.ts`
- 创建：`packages/domain/src/session/service.ts`
- 创建：`packages/domain/src/role-manager/service.ts`
- 创建：`packages/domain/src/role-manager/types.ts`
- 创建：`packages/pi-client/src/client.ts`
- 创建：`packages/pi-client/src/types.ts`
- 创建：`packages/pi-client/src/index.ts`
- 创建：`packages/domain/src/extensions/spawn-session.ts`
- 创建：`packages/domain/src/extensions/writeback-to-parent.ts`

- [ ] **步骤 1：编写 spawn_session 结构测试**

```ts
import { expect, test } from "bun:test";
import { buildSpawnSessionInput } from "@piplus/domain/extensions/spawn-session";

test("spawn session input only exposes role target constraints", () => {
  const input = buildSpawnSessionInput({ role: "planner", target: "plan", constraints: [] });
  expect(Object.keys(input)).toEqual(["role", "target", "constraints"]);
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test packages/domain`
预期：工具层结构尚未实现。

- [ ] **步骤 3：实现最少骨架**

```ts
export function buildSpawnSessionInput(input) {
  return { role: input.role, target: input.target, constraints: input.constraints };
}
```

- [ ] **步骤 4：验证内部边界**

运行：`bun test packages/domain`
预期：spawn_session / writeback_to_parent 只存在于内部层，不出现在 `apps/web`。

- [ ] **步骤 5：Commit**

```bash
git add packages/domain packages/pi-client
git commit -m "feat: scaffold role management layers"
```

### 任务 7：实现 `apps/web` 工作台壳层与基础页面

**文件：**
- 创建：`apps/web/app/layout.tsx`
- 创建：`apps/web/app/page.tsx`
- 创建：`apps/web/app/globals.css`
- 创建：`apps/web/src/components/layout-shell.tsx`
- 创建：`apps/web/src/components/project-tree.tsx`
- 创建：`apps/web/src/components/chat-panel.tsx`
- 创建：`apps/web/src/components/session-info-panel.tsx`
- 创建：`apps/web/src/providers/query-provider.tsx`
- 创建：`packages/ui/src/button.tsx`
- 创建：`packages/ui/src/tabs.tsx`

- [ ] **步骤 1：编写壳层渲染测试**

```tsx
import { render } from "@testing-library/react";
import { LayoutShell } from "../src/components/layout-shell";

test("renders tree and right panel", () => {
  const view = render(<LayoutShell />);
  expect(view.getByText("Chat")).toBeTruthy();
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`bun test apps/web`
预期：页面壳与组件尚未实现。

- [ ] **步骤 3：实现最少 UI**

```tsx
export function LayoutShell() {
  return <div className="grid grid-cols-[320px_1fr]">...</div>;
}
```

- [ ] **步骤 4：验证桌面与移动基础布局**

运行：`bun --cwd apps/web dev`
预期：左树、Chat、Session Info、顶部 tabs 和基础响应式布局可见。

- [ ] **步骤 5：Commit**

```bash
git add apps/web packages/ui
git commit -m "feat: add web workspace shell"
```

### 任务 8：完成端到端联调、种子与验收脚本

**文件：**
- 创建：`scripts/seed.ts`
- 创建：`scripts/check-api.ts`
- 创建：`scripts/check-web.ts`
- 创建：`README.md`
- 创建：`docs/verification/initial-foundation.md`

- [ ] **步骤 1：编写验收脚本**

```ts
const res = await fetch("http://localhost:3001/api/v1/tree");
console.log(await res.json());
```

- [ ] **步骤 2：运行联调检查**

运行：`bun run dev`，再执行 `bun run scripts/check-api.ts`。
预期：API、Web、SQLite、WS、认证与基础页面能同时启动并互相连通。

- [ ] **步骤 3：记录遗留项**

```md
- PI SDK 实际接入尚未完成
- chat_stream 实际 token 代理尚未接通
- Session Info 数据聚合仍为基础实现
```

- [ ] **步骤 4：Commit**

```bash
git add scripts README.md docs/verification
git commit -m "chore: add initial verification scaffolding"
```"}],"path":"/home/ivhu/code/piplus/docs/superpowers/plans/2026-06-02-initial-workspace-foundation.md"}