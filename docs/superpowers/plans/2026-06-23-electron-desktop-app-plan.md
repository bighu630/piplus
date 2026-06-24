# piplus Electron 本地桌面应用（方案一）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在不影响现有 `apps/web` 与 `apps/api` 独立开发、独立启动方式的前提下，为 piplus 增加一个可打包的 Electron 桌面壳；桌面态由 Electron 主进程启动本地 Bun API，前端继续通过 `fetch` 与 `WebSocket` 访问本地 API。

**架构：** 新增 `apps/desktop` 作为 Electron 宿主层。主进程负责动态端口申请、数据目录计算、API 子进程启动与健康检查、窗口创建和运行时配置注入；`apps/web` 仅增加统一的 runtime config 读取层；`apps/api` 仅做最小桌面兼容改造，收敛监听地址与数据目录来源。

**技术栈：** Electron、TypeScript、Bun、Hono、Vite、electron-builder

---

## 文件结构

### 新增文件

- `apps/desktop/package.json`：Electron 应用依赖、脚本与打包入口
- `apps/desktop/tsconfig.json`：桌面应用 TypeScript 配置
- `apps/desktop/src/main/index.ts`：Electron 主进程入口
- `apps/desktop/src/main/paths.ts`：平台数据目录与子路径计算
- `apps/desktop/src/main/port.ts`：动态端口申请
- `apps/desktop/src/main/api-process.ts`：Bun API 子进程启动、日志接入与退出清理
- `apps/desktop/src/main/health.ts`：`/health` 等待逻辑
- `apps/desktop/src/main/window.ts`：`BrowserWindow` 创建与加载逻辑
- `apps/desktop/src/preload/index.ts`：通过 `contextBridge` 暴露只读 `piplusConfig`
- `apps/desktop/electron-builder.yml`：桌面打包配置
- `apps/desktop/scripts/dev.ts` 或 `apps/desktop/scripts/dev.mjs`：桌面开发启动脚本（如项目选择脚本式联调）
- `apps/web/src/lib/runtime-config.ts`：统一读取 Electron 注入与 Vite 环境变量
- `apps/web/src/types/runtime-config.d.ts`：声明 `window.piplusConfig` 类型
- `docs/verification/electron-desktop-mvp.md`：桌面 MVP 手工验证步骤（如果现有 `docs/verification` 风格适合）

### 修改文件

- `package.json`：新增顶层 desktop 相关脚本
- `apps/api/src/index.ts`：收敛 host / port 读取，支持桌面态监听 `127.0.0.1`
- `apps/api/package.json`：新增桌面兼容或构建相关脚本（如需要）
- `apps/api` 内现有配置文件（若存在，例如 `config` 或 `db-context` 相关文件）：收敛 `PIPLUS_DATA_DIR` / `DATABASE_URL` 来源
- `apps/web` 现有 API client 文件：统一从 `runtime-config.ts` 读取 `apiBaseUrl`
- `apps/web` 现有 WS client 文件：统一从 `runtime-config.ts` 读取 `wsBaseUrl`

### 测试文件

- `apps/web/src/lib/runtime-config.test.ts`（若当前 web 测试栈允许新增）
- `apps/api` 中与配置相关的测试文件（若已有相邻测试模式，可补充最小测试）
- `apps/desktop` 可优先不写完整自动化测试，但需配套验证文档与最小可运行检查

---

## 任务 1：梳理现有 API / Web 的配置接入点

**文件：**
- 修改：`apps/web` 中现有 API client 与 WS client 文件（待实现时精确定位）
- 修改：`apps/api/src/index.ts`
- 修改：`apps/api` 中读取数据库或 env 的现有文件（待实现时精确定位）
- 测试：无（本任务以定位与最小重构为主）

- [ ] **步骤 1：定位前端 API 与 WebSocket 地址来源**

运行：`rg -n "fetch\(|WebSocket\(|API_BASE|WS_BASE|localhost|127.0.0.1|/ws" apps/web/src -S`
预期：列出前端当前所有 HTTP / WS 地址拼接点，为后续统一接入提供依据。

- [ ] **步骤 2：定位后端端口、host、数据库路径来源**

运行：`rg -n "Bun\.env|process\.env|DATABASE_URL|API_PORT|host|Bun\.serve|listen" apps/api/src -S`
预期：列出后端当前读取 env 与绑定网络、数据库路径的关键文件。

- [ ] **步骤 3：记录需要改造的精确文件与符号**

将定位结果整理到计划执行备注中，至少明确：

```text
- web 中哪个文件负责拼接 HTTP base URL
- web 中哪个文件负责创建 WebSocket URL
- api 中哪个文件负责读取 port / host
- api 中哪个文件负责解析 DATABASE_URL 或落地 sqlite 路径
```

预期：后续任务可以直接按文件修改，不再重新摸索。

- [ ] **步骤 4：运行现有最小类型检查基线**

运行：`bun --cwd apps/web run lint && bun --cwd apps/api run typecheck`
预期：在改造前确认当前 web / api 基线可通过，避免把历史问题误认为新问题。

- [ ] **步骤 5：Commit**

```bash
git add docs/superpowers/plans/2026-06-23-electron-desktop-app-plan.md
git commit -m "docs: add electron desktop implementation plan"
```

## 任务 2：为 `apps/web` 增加统一 runtime config 读取层

**文件：**
- 创建：`apps/web/src/lib/runtime-config.ts`
- 创建：`apps/web/src/types/runtime-config.d.ts`
- 修改：`apps/web` 现有 API client 文件
- 修改：`apps/web` 现有 WS client 文件
- 测试：`apps/web/src/lib/runtime-config.test.ts`（若可行）

- [ ] **步骤 1：编写失败的配置读取测试（若 web 测试栈支持）**

```ts
import { describe, expect, it } from 'vitest';
import { resolveRuntimeConfig } from './runtime-config';

describe('resolveRuntimeConfig', () => {
  it('prefers desktop injected config', () => {
    const config = resolveRuntimeConfig({
      desktopConfig: {
        isDesktop: true,
        apiBaseUrl: 'http://127.0.0.1:43127',
        wsBaseUrl: 'ws://127.0.0.1:43127',
        platform: 'darwin',
      },
      env: {
        VITE_API_BASE_URL: 'http://localhost:3001',
        VITE_WS_BASE_URL: 'ws://localhost:3001',
      },
    });

    expect(config.apiBaseUrl).toBe('http://127.0.0.1:43127');
    expect(config.wsBaseUrl).toBe('ws://127.0.0.1:43127');
    expect(config.isDesktop).toBe(true);
  });
});
```

运行：`bun --cwd apps/web test`
预期：FAIL，报错缺少 `runtime-config` 实现或测试脚本未接通（如果当前无测试脚本，则记录并跳过到实现步骤，同时保持代码可测结构）。

- [ ] **步骤 2：实现最小 runtime config 解析模块**

```ts
export type DesktopRuntimeConfig = {
  isDesktop: boolean;
  apiBaseUrl: string;
  wsBaseUrl: string;
  platform: string;
};

export type RuntimeConfig = {
  isDesktop: boolean;
  apiBaseUrl: string;
  wsBaseUrl: string;
};

export function resolveRuntimeConfig(input?: {
  desktopConfig?: DesktopRuntimeConfig | undefined;
  env?: Record<string, string | undefined>;
}): RuntimeConfig {
  const desktopConfig = input?.desktopConfig;
  if (desktopConfig?.apiBaseUrl && desktopConfig?.wsBaseUrl) {
    return {
      isDesktop: !!desktopConfig.isDesktop,
      apiBaseUrl: desktopConfig.apiBaseUrl,
      wsBaseUrl: desktopConfig.wsBaseUrl,
    };
  }

  const env = input?.env ?? import.meta.env;
  const apiBaseUrl = env.VITE_API_BASE_URL;
  const wsBaseUrl = env.VITE_WS_BASE_URL;

  if (!apiBaseUrl || !wsBaseUrl) {
    throw new Error('Missing runtime config: VITE_API_BASE_URL / VITE_WS_BASE_URL');
  }

  return {
    isDesktop: false,
    apiBaseUrl,
    wsBaseUrl,
  };
}

export const runtimeConfig = resolveRuntimeConfig({
  desktopConfig: typeof window !== 'undefined' ? window.piplusConfig : undefined,
});
```

预期：形成统一配置入口，并显式处理桌面态优先级。

- [ ] **步骤 3：声明 `window.piplusConfig` 全局类型**

```ts
import type { DesktopRuntimeConfig } from '../lib/runtime-config';

declare global {
  interface Window {
    piplusConfig?: DesktopRuntimeConfig;
  }
}

export {};
```

预期：前端在 TypeScript 下可安全访问桌面注入对象。

- [ ] **步骤 4：让 API client 与 WS client 改为统一走配置层**

将现有：

```ts
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const WS_BASE_URL = import.meta.env.VITE_WS_BASE_URL;
```

替换为：

```ts
import { runtimeConfig } from './runtime-config';

const API_BASE_URL = runtimeConfig.apiBaseUrl;
const WS_BASE_URL = runtimeConfig.wsBaseUrl;
```

预期：前端所有 HTTP / WS 地址都从同一个入口读取。

- [ ] **步骤 5：运行前端类型检查与相关测试**

运行：`bun --cwd apps/web run lint`
预期：PASS。

如果接通了测试脚本，再运行：`bun --cwd apps/web test`
预期：PASS；若项目当前没有稳定 web 测试脚本，则在执行记录中明确说明仅完成类型检查。

- [ ] **步骤 6：Commit**

```bash
git add apps/web/src/lib/runtime-config.ts apps/web/src/types/runtime-config.d.ts apps/web
git commit -m "feat: add desktop runtime config for web"
```

## 任务 3：让 `apps/api` 支持桌面态 host / port / data dir 收敛

**文件：**
- 修改：`apps/api/src/index.ts`
- 修改：`apps/api` 中读取数据库路径或 env 的文件（按任务 1 定位结果）
- 测试：相邻 API 测试文件（若已有配置测试模式则补充）

- [ ] **步骤 1：编写一个最小失败测试，覆盖 env 驱动配置**

如果当前 API 测试栈适合新增配置函数测试，则先抽出可测函数，例如：

```ts
import { expect, test } from 'bun:test';
import { resolveServerConfig } from './server-config';

test('resolveServerConfig uses desktop-safe defaults', () => {
  const config = resolveServerConfig({
    API_PORT: '43127',
    API_HOST: '127.0.0.1',
  });

  expect(config.port).toBe(43127);
  expect(config.host).toBe('127.0.0.1');
});
```

运行：`bun --cwd apps/api test`
预期：FAIL，提示缺少配置函数或断言不通过。

- [ ] **步骤 2：抽出可复用的服务端配置解析函数**

```ts
export function resolveServerConfig(env: Record<string, string | undefined>) {
  return {
    host: env.API_HOST ?? '127.0.0.1',
    port: Number(env.API_PORT ?? '3001'),
    dataDir: env.PIPLUS_DATA_DIR,
    databaseUrl: env.DATABASE_URL,
  };
}
```

预期：把桌面态需要的 host / port / path 决策从入口文件中抽离出来，降低后续集成复杂度。

- [ ] **步骤 3：修改 API 入口使用配置函数并绑定 host**

将现有类似：

```ts
const port = Number(Bun.env.API_PORT ?? 3001);

Bun.serve({
  port,
  fetch: app.fetch,
  websocket,
});
```

改为：

```ts
const config = resolveServerConfig(Bun.env);

Bun.serve({
  hostname: config.host,
  port: config.port,
  fetch: app.fetch,
  websocket,
});
```

预期：桌面态可显式锁定到 `127.0.0.1`，网页开发态也仍可通过 env 覆盖。

- [ ] **步骤 4：收敛数据库与数据目录来源**

将散落的数据库路径决策改为优先读取：

```ts
const dataDir = env.PIPLUS_DATA_DIR;
const databaseUrl = env.DATABASE_URL ?? (dataDir ? `file:${dataDir}/app.db` : undefined);
```

预期：桌面态由 Electron 统一注入路径；现有独立 API 启动方式仍可通过 `.env` 或默认值继续工作。

- [ ] **步骤 5：运行 API 测试与类型检查**

运行：`bun --cwd apps/api test && bun --cwd apps/api run typecheck`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/api/src apps/api
git commit -m "feat: support desktop api runtime config"
```

## 任务 4：搭建 `apps/desktop` 基础骨架

**文件：**
- 创建：`apps/desktop/package.json`
- 创建：`apps/desktop/tsconfig.json`
- 创建：`apps/desktop/src/main/index.ts`
- 创建：`apps/desktop/src/main/window.ts`
- 创建：`apps/desktop/src/preload/index.ts`
- 测试：无（先确保可编译与可启动）

- [ ] **步骤 1：创建 `apps/desktop/package.json`**

```json
{
  "name": "@piplus/desktop",
  "private": true,
  "type": "module",
  "main": "dist/main/index.js",
  "scripts": {
    "dev": "electron .",
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "electron": "^37.0.0"
  },
  "devDependencies": {
    "typescript": "^6.0.0"
  }
}
```

预期：桌面应用拥有独立 workspace 与脚本入口。

- [ ] **步骤 2：创建桌面 tsconfig**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "ESNext",
    "target": "ES2022",
    "moduleResolution": "Bundler",
    "types": ["node"]
  },
  "include": ["src"]
}
```

预期：桌面代码可独立类型检查与构建。

- [ ] **步骤 3：创建最小 Electron 主进程与 preload**

```ts
import { app } from 'electron';
import { createMainWindow } from './window';

app.whenReady().then(async () => {
  await createMainWindow();
});
```

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('piplusConfig', {
  isDesktop: true,
  apiBaseUrl: 'http://127.0.0.1:3001',
  wsBaseUrl: 'ws://127.0.0.1:3001',
  platform: process.platform,
});
```

预期：先搭起可启动壳子，后续再替换静态值为真实动态配置。

- [ ] **步骤 4：创建最小窗口加载逻辑**

```ts
import { BrowserWindow } from 'electron';
import path from 'node:path';

export async function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    webPreferences: {
      preload: path.join(process.cwd(), 'dist/preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.PIPLUS_WEB_DEV_URL) {
    await window.loadURL(process.env.PIPLUS_WEB_DEV_URL);
    return window;
  }

  await window.loadFile(path.join(process.cwd(), '../web/dist/index.html'));
  return window;
}
```

预期：支持桌面开发态连 dev server，生产态加载 web build。

- [ ] **步骤 5：运行桌面类型检查**

运行：`bun --cwd apps/desktop run typecheck`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add apps/desktop
git commit -m "feat: scaffold desktop electron app"
```

## 任务 5：实现桌面态动态端口、数据目录与 API 子进程启动

**文件：**
- 创建：`apps/desktop/src/main/paths.ts`
- 创建：`apps/desktop/src/main/port.ts`
- 创建：`apps/desktop/src/main/api-process.ts`
- 创建：`apps/desktop/src/main/health.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 测试：无自动化硬性要求，至少需可运行验证

- [ ] **步骤 1：实现平台数据目录计算**

```ts
import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';

export async function ensureAppPaths() {
  const dataDir = path.join(app.getPath('userData'), 'piplus');
  const logsDir = path.join(dataDir, 'logs');
  const runtimeDir = path.join(dataDir, 'runtime');
  const cacheDir = path.join(dataDir, 'cache');

  await Promise.all([
    fs.mkdir(dataDir, { recursive: true }),
    fs.mkdir(logsDir, { recursive: true }),
    fs.mkdir(runtimeDir, { recursive: true }),
    fs.mkdir(cacheDir, { recursive: true }),
  ]);

  return {
    dataDir,
    logsDir,
    runtimeDir,
    cacheDir,
    databasePath: path.join(dataDir, 'app.db'),
  };
}
```

预期：桌面态应用启动前即拥有可写数据目录。

- [ ] **步骤 2：实现动态端口申请**

```ts
import net from 'node:net';

export async function getFreePort(host = '127.0.0.1'): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}
```

预期：Electron 每次启动都获得一个新的本地空闲端口。

- [ ] **步骤 3：实现 API 子进程启动与清理**

```ts
import { spawn, type ChildProcess } from 'node:child_process';

export function startApiProcess(input: {
  bunExecutable: string;
  cwd: string;
  apiEntry: string;
  port: number;
  dataDir: string;
  databasePath: string;
  appPassword?: string;
}): ChildProcess {
  return spawn(input.bunExecutable, [input.apiEntry], {
    cwd: input.cwd,
    env: {
      ...process.env,
      API_HOST: '127.0.0.1',
      API_PORT: String(input.port),
      PIPLUS_DATA_DIR: input.dataDir,
      DATABASE_URL: `file:${input.databasePath}`,
      ...(input.appPassword ? { APP_PASSWORD: input.appPassword } : {}),
    },
    stdio: 'pipe',
  });
}
```

预期：主进程掌控 API 启动环境变量，并显式注入动态端口与数据目录。

- [ ] **步骤 4：实现 `/health` 等待并接入主进程启动链路**

```ts
export async function waitForHealth(url: string, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // ignore
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`API health check timed out: ${url}`);
}
```

在 `main/index.ts` 中串联：

```ts
const paths = await ensureAppPaths();
const port = await getFreePort();
const apiProcess = startApiProcess({ ... });
await waitForHealth(`http://127.0.0.1:${port}/health`);
await createMainWindow({
  apiBaseUrl: `http://127.0.0.1:${port}`,
  wsBaseUrl: `ws://127.0.0.1:${port}`,
});
```

预期：只有 API ready 后才创建窗口。

- [ ] **步骤 5：让 preload 使用主进程生成的真实配置**

通过 `BrowserWindow` 的 `webPreferences.additionalArguments`、自定义协议，或更简单的 preload 共享文件方式，把：

```ts
{
  isDesktop: true,
  apiBaseUrl,
  wsBaseUrl,
  platform: process.platform,
}
```

传给 preload 并暴露到 `window.piplusConfig`。

预期：renderer 可获得真实动态端口地址，而非静态占位值。

- [ ] **步骤 6：运行桌面类型检查与最小启动验证**

运行：`bun --cwd apps/desktop run typecheck`
预期：PASS。

运行：`bun --cwd apps/desktop run dev`
预期：Electron 启动；若 `PIPLUS_WEB_DEV_URL` 已配置，窗口可加载前端；API 子进程成功绑定动态端口并通过 `/health`。

- [ ] **步骤 7：Commit**

```bash
git add apps/desktop
git commit -m "feat: start local api from desktop shell"
```

## 任务 6：接通顶层脚本与打包配置

**文件：**
- 修改：`package.json`
- 创建：`apps/desktop/electron-builder.yml`
- 修改：`apps/desktop/package.json`
- 测试：桌面构建与打包命令

- [ ] **步骤 1：在根 `package.json` 中增加 desktop 脚本**

```json
{
  "scripts": {
    "dev:desktop": "bun --cwd apps/desktop run dev",
    "typecheck:desktop": "bun --cwd apps/desktop run typecheck",
    "build:desktop": "bun --cwd apps/desktop run build"
  }
}
```

预期：桌面工作流可以从仓库根目录统一触发。

- [ ] **步骤 2：补充 `electron-builder` 配置**

```yaml
appId: com.piplus.desktop
productName: piplus
files:
  - dist/**
  - package.json
extraResources:
  - from: ../web/dist
    to: web-dist
  - from: ../api
    to: api
mac:
  target:
    - dmg
linux:
  target:
    - AppImage
win:
  target:
    - nsis
```

预期：初步定义三平台桌面产物结构；后续可再细化 Bun runtime 与图标资源。

- [ ] **步骤 3：补充 desktop 构建脚本，区分开发态与生产态资源路径**

在 `apps/desktop/package.json` 中增加如：

```json
{
  "scripts": {
    "build:web": "bun --cwd ../web run build",
    "build": "tsc -p tsconfig.json",
    "pack": "electron-builder --dir",
    "dist": "electron-builder"
  }
}
```

预期：桌面项目具备最小打包命令链。

- [ ] **步骤 4：运行桌面构建命令**

运行：`bun --cwd apps/desktop run build`
预期：PASS。

如环境允许，再运行：`bun --cwd apps/desktop run pack`
预期：至少能生成 unpacked 产物；若 Bun runtime 资源尚未完整纳入，记录当前阻塞点。

- [ ] **步骤 5：Commit**

```bash
git add package.json apps/desktop/package.json apps/desktop/electron-builder.yml
git commit -m "build: add desktop scripts and packaging config"
```

## 任务 7：编写桌面 MVP 验证文档并做回归检查

**文件：**
- 创建：`docs/verification/electron-desktop-mvp.md`
- 修改：必要时更新 `docs/superpowers/specs/2026-06-23-electron-desktop-app-design.md`
- 测试：手工验证命令与结果记录

- [ ] **步骤 1：编写手工验证清单**

```md
# Electron Desktop MVP 验证

1. 启动 `bun run dev:desktop`
2. 确认窗口成功打开
3. 确认 API 监听地址为 `127.0.0.1:<dynamic-port>`
4. 确认登录接口可用
5. 确认 WebSocket 连接成功
6. 退出 Electron，确认 API 子进程退出
7. 重启应用，确认数据库文件仍在应用数据目录
```

预期：桌面 MVP 有明确的验收路径。

- [ ] **步骤 2：执行回归检查**

运行：`bun --cwd apps/web run lint && bun --cwd apps/api run typecheck && bun --cwd apps/api test && bun --cwd apps/desktop run typecheck`
预期：PASS。

如环境允许，再执行：`bun run dev:desktop`
预期：桌面集成链路跑通。

- [ ] **步骤 3：记录任何未解决但不阻塞 MVP 的问题**

例如：

```md
- Windows 打包未验证
- Bun runtime 打包路径仍需在真实产物中确认
- 自动重启策略延后到 Phase 2
```

预期：交付结果与剩余风险边界清晰。

- [ ] **步骤 4：Commit**

```bash
git add docs/verification/electron-desktop-mvp.md
git commit -m "docs: add desktop mvp verification checklist"
```

---

## 自检结果

### 规格覆盖度

- 已覆盖 `apps/desktop` 的引入、职责划分、动态端口、数据目录、API 子进程、preload 注入、打包配置与验证策略。
- 已覆盖 `apps/web` 的 runtime config 接入。
- 已覆盖 `apps/api` 的 host / port / data dir 最小兼容改造。
- 已覆盖三平台目标与 `electron-builder` 的首轮配置。

### 占位符扫描

- 未使用 `TODO`、`待定`、`后续补充实现` 等空泛步骤。
- 个别「按任务 1 定位结果修改精确文件」是基于当前尚未执行 code search 的计划写法，但其目的是约束执行顺序，不是留空需求；任务 1 完成后应在执行记录中补齐精确路径。

### 类型一致性

- 桌面注入类型统一命名为 `DesktopRuntimeConfig`。
- 前端统一消费 `runtimeConfig.apiBaseUrl` 与 `runtimeConfig.wsBaseUrl`。
- 后端服务配置统一收敛为 `resolveServerConfig()`，避免后续命名漂移。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-23-electron-desktop-app-plan.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中逐任务执行，批量推进并在关键节点回报

如果你愿意，我现在可以直接继续按这份计划开始实现。