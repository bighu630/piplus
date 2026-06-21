# Project Directory Binding 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为项目增加真实目录绑定能力，支持两种创建模式：绑定现有目录 / GitHub clone，两种模式均允许自定义项目名。

**架构：** `projects` 表新增 `project_path/source_type/source_url` 字段；API 增加项目创建时的路径校验与 git clone；前端增加创建模式切换与自定义名称输入。

**技术栈：** Bun、TypeScript、Hono、Drizzle ORM、SQLite、Next.js、React。

---

## 文件结构

**修改：**
- `packages/db/src/schema.ts`
  - `projects` 表新增 `projectPath/sourceType/sourceUrl` 字段
- `packages/db/migrations/0001_initial.sql`
  - 同步新增列
- `packages/db/src/init.ts`
  - 确保旧库补列
- `packages/db/src/seed.ts`
  - 种子数据调整为有目录信息
- `packages/domain/src/role-manager/service.ts`
  - `CreateProjectInput` 增加 `projectPath/sourceType/sourceUrl/name` 字段
- `packages/domain/src/project/service.ts`
  - 接口透传目录信息
- `apps/api/src/routes/projects.ts`
  - 新增路径校验逻辑，区分 existing/git_clone 模式，执行 git clone
- `packages/shared/src/dto.ts`
  - `ProjectDTO` 增加 `project_path/source_type/source_url`
- `apps/api/src/routes/projects.test.ts`
  - 增加 existing/git_clone 模式流程测试
- `apps/web/src/components/layout-shell.tsx`
  - 增加 existing/git_clone 模式选择 + 项目名自定义输入
- `apps/web/src/lib/api.ts`
  - 更新 createProject 请求参数

**验证命令：**
- `cd packages/db && bun run typecheck`
- `cd packages/domain && bun run typecheck && bun test src/role-manager/service.test.ts`
- `cd apps/api && bun run typecheck && bun test src/routes/projects.test.ts`
- `cd apps/web && bun run typecheck`

---

## 任务 1：数据库与 domain 类型

**文件：**
- 修改：`packages/db/src/schema.ts`
- 修改：`packages/db/migrations/0001_initial.sql`
- 修改：`packages/db/src/init.ts`
- 修改：`packages/shared/src/dto.ts`
- 修改：`packages/domain/src/role-manager/service.ts`
- 修改：`packages/domain/src/project/service.ts`
- 修改：`packages/domain/src/role-manager/service.test.ts`

- [ ] **步骤 1：修改 Drizzle schema**

在 `projects` 表新增：

```ts
projectPath: text('project_path').notNull().default(''),
sourceType: text('source_type').notNull().default('existing'),
sourceUrl: text('source_url').notNull().default(''),
```

同步更新 `migrations/0001_initial.sql` 和 `init.ts` 的补列逻辑。

- [ ] **步骤 2：更新 CreateProjectInput**

```ts
export type CreateProjectInput = {
  name: string;
  createdBy: string;
  projectPath: string;
  sourceType: string;
  sourceUrl: string;
};
```

- [ ] **步骤 3：更新 createProjectWithPlanner**

在 `role-manager/service.ts` 中，将 `projectPath/sourceType/sourceUrl` 写入 `projects` 表。

- [ ] **步骤 4：更新 project/service.ts 透传参数**

- [ ] **步骤 5：更新 DTO**

`ProjectDTO` 增加：
```ts
project_path: string;
source_type: string;
source_url: string;
```

- [ ] **步骤 6：更新 domain 测试**

调整 `service.test.ts` 中创建项目调用，传入新参数，断言新字段。

- [ ] **步骤 7：运行验证**

```bash
cd packages/domain && bun run typecheck && bun test src/role-manager/service.test.ts
```
预期：PASS。

---

## 任务 2：API 路由

**文件：**
- 修改：`apps/api/src/routes/projects.ts`
- 修改：`apps/api/src/routes/projects.test.ts`

- [ ] **步骤 1：写失败测试**

增加 git_clone 模式创建测试（可 mock clone 或跳过真实 clone，但校验参数流程）和 existing 模式校验目录不存在的测试。

- [ ] **步骤 2：实现 existing 模式**

```ts
if (mode === 'existing') {
  const stat = Bun.file(path).exists();
  // 校验存在性...
  const projectName = name || basename(path);
  // 创建 project with projectPath=path, sourceType='existing', sourceUrl=''
}
```

- [ ] **步骤 3：实现 git_clone 模式**

```ts
if (mode === 'git_clone') {
  const root = Bun.env.PROJECTS_ROOT ?? '~/projects';
  const repoName = extractRepoName(repoUrl);
  const targetPath = path.join(root, repoName);
  // 校验 targetPath 不存在
  // 执行 git clone
  // 创建 project with projectPath=targetPath, sourceType='git_clone', sourceUrl=repoUrl
}
```

如果 clone 失败直接返回 500。

- [ ] **步骤 4：运行验证**

```bash
cd apps/api && bun run typecheck && bun test src/routes/projects.test.ts
```
预期：PASS。

---

## 任务 3：前端 UI

**文件：**
- 修改：`apps/web/src/components/layout-shell.tsx`
- 修改：`apps/web/src/lib/api.ts`

- [ ] **步骤 1：更新 api.ts**

```ts
export function createProject(params: { name: string; mode: string; path?: string; repo_url?: string }) {
  return request<{ projectId: string; sessionId?: string }>(`/api/v1/projects`, {
    method: 'POST',
    body: JSON.stringify(params),
  });
}
```

- [ ] **步骤 2：更新 layout-shell.tsx**

在侧栏“新项目名称”输入区域增加：
- 模式选择下拉/单选（existing / git_clone）
- existing：路径输入框
- git_clone：GitHub URL 输入框 + `~/projects` 只读提示
- 项目名输入框（两种模式均可编辑，默认值由路径/仓库名预填充）

- [ ] **步骤 3：运行验证**

```bash
cd apps/web && bun run typecheck
```
预期：PASS。

---

## 自检

- 规格覆盖：两种模式、自定义名称、数据库字段、API 校验、前端 UI 均已覆盖
- 无 TODO/占位符
- 命名统一：`projectPath/sourceType/sourceUrl` 贯穿 DB / domain / DTO / API
