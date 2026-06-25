# Piplus Docker 化部署实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 为 Piplus 提供单容器、单端口、基于 Bun 的 Docker 化部署方案，支持 `PUBLIC_WEB_ORIGIN` 构建时注入、非 root `app` 用户运行，以及 Pi / Piplus 数据目录外挂。

**架构：** 使用一个 Docker 镜像同时承载 `apps/api` 和 `apps/web`。构建阶段安装 workspace 依赖并构建 Web 前端；运行阶段仅启动 API，由 API 托管前端静态资源、HTTP API 和 WebSocket。前端通过 `PUBLIC_WEB_ORIGIN` 在构建时派生 API / WS 地址，后端在运行时用同一变量收敛 CORS。

**技术栈：** Bun、Hono、Vite、Docker、Docker Compose

---

## 文件结构

### 新增文件
- `Dockerfile`：单容器镜像定义，创建 `app` 用户，安装依赖，构建前端，运行 API
- `docker-compose.yml`：本地 / 部署启动入口，定义 build args、环境变量、端口与卷挂载
- `deployment/docker/README.md`：Docker 部署说明、环境变量说明、启动方式、域名变更后的重建说明
- `deployment/docker/.env.example`：示例配置，包含 `PUBLIC_WEB_ORIGIN`

### 修改文件
- `apps/api/src/app.ts`：收敛 CORS；完善生产模式静态资源托管与 SPA fallback
- `apps/api/src/app.test.ts`：新增 API 应用级测试，覆盖 CORS 与静态页面服务行为
- `apps/web/src/lib/runtime-config.ts`：保留现有接口，确保构建时注入变量与 fallback 行为清晰可测
- `apps/web/src/lib/runtime-config.test.ts`：新增运行时配置派生测试
- `README.md`：补充 Docker 使用入口，指向部署文档

---

### 任务 1：为前端运行时配置补测试并固定 `PUBLIC_WEB_ORIGIN` 注入行为

**文件：**
- 创建：`apps/web/src/lib/runtime-config.test.ts`
- 修改：`apps/web/src/lib/runtime-config.ts`
- 测试：`apps/web/src/lib/runtime-config.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { getApiBaseUrl, getWsBaseUrl } from './runtime-config';

describe('runtime config', () => {
  const originalWindow = globalThis.window;
  const originalApi = import.meta.env.VITE_API_BASE_URL;
  const originalWs = import.meta.env.VITE_WS_BASE_URL;

  afterEach(() => {
    globalThis.window = originalWindow;
    import.meta.env.VITE_API_BASE_URL = originalApi;
    import.meta.env.VITE_WS_BASE_URL = originalWs;
  });

  test('uses vite env api and ws base urls when provided', () => {
    globalThis.window = {
      location: {
        protocol: 'https:',
        host: 'current.example.com',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;

    import.meta.env.VITE_API_BASE_URL = 'https://public.example.com/';
    import.meta.env.VITE_WS_BASE_URL = 'wss://public.example.com/';

    expect(getApiBaseUrl()).toBe('https://public.example.com');
    expect(getWsBaseUrl()).toBe('wss://public.example.com');
  });

  test('falls back to browser websocket origin when vite ws env is absent', () => {
    globalThis.window = {
      location: {
        protocol: 'https:',
        host: 'current.example.com',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;

    import.meta.env.VITE_API_BASE_URL = '';
    import.meta.env.VITE_WS_BASE_URL = '';

    expect(getApiBaseUrl()).toBe('');
    expect(getWsBaseUrl()).toBe('wss://current.example.com');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/web && bun test src/lib/runtime-config.test.ts`
预期：FAIL，报错测试文件不存在或当前行为与测试预期不匹配。

- [ ] **步骤 3：编写最少实现代码**

```ts
function getEnvBaseUrl(key: 'VITE_API_BASE_URL' | 'VITE_WS_BASE_URL') {
  const value = import.meta.env[key];
  return normalizeOptionalBaseUrl(value);
}

export function getApiBaseUrl() {
  const config = getRuntimeConfig();
  return normalizeOptionalBaseUrl(config.apiBaseUrl) ?? getEnvBaseUrl('VITE_API_BASE_URL') ?? '';
}

export function getWsBaseUrl() {
  const config = getRuntimeConfig();
  return normalizeOptionalBaseUrl(config.wsBaseUrl)
    ?? getEnvBaseUrl('VITE_WS_BASE_URL')
    ?? getBrowserDefaultWsBaseUrl();
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/web && bun test src/lib/runtime-config.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/web/src/lib/runtime-config.ts apps/web/src/lib/runtime-config.test.ts
git commit -m "test: cover docker runtime url config"
```

### 任务 2：为 API 的 CORS 与静态页面托管补测试

**文件：**
- 创建：`apps/api/src/app.test.ts`
- 修改：`apps/api/src/app.ts`
- 测试：`apps/api/src/app.test.ts`

- [ ] **步骤 1：编写失败的测试**

```ts
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from './app';

describe('createApp docker serving', () => {
  const originalOrigin = process.env.PUBLIC_WEB_ORIGIN;
  const originalServeWeb = process.env.PIPLUS_SERVE_WEB;
  const originalWebDist = process.env.PIPLUS_WEB_DIST;

  afterEach(() => {
    process.env.PUBLIC_WEB_ORIGIN = originalOrigin;
    process.env.PIPLUS_SERVE_WEB = originalServeWeb;
    process.env.PIPLUS_WEB_DIST = originalWebDist;
  });

  test('returns configured cors origin for api responses', async () => {
    process.env.PUBLIC_WEB_ORIGIN = 'https://demo.example.com';
    const app = createApp();

    const response = await app.request('/health', {
      headers: { Origin: 'https://demo.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://demo.example.com');
  });

  test('serves index html for non-api routes when docker web serving is enabled', async () => {
    const webDist = join(tmpdir(), `piplus-web-${Date.now()}`);
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><body>Piplus</body></html>');

    process.env.PIPLUS_SERVE_WEB = '1';
    process.env.PIPLUS_WEB_DIST = webDist;

    const app = createApp();
    const response = await app.request('/projects/123');
    const body = await response.text();

    rmSync(webDist, { recursive: true, force: true });

    expect(response.status).toBe(200);
    expect(body).toContain('Piplus');
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`cd apps/api && bun test src/app.test.ts`
预期：FAIL，静态页面 fallback 尚未实现，或 CORS 行为与预期不一致。

- [ ] **步骤 3：编写最少实现代码**

```ts
const configuredOrigin = process.env.PUBLIC_WEB_ORIGIN?.trim();

app.use(
  '*',
  cors({
    origin: (origin) => {
      if (!configuredOrigin) return origin ?? '*';
      if (!origin) return configuredOrigin;
      return origin === configuredOrigin ? configuredOrigin : '';
    },
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'x-user-id', 'Authorization'],
    credentials: false,
  }),
);

if (process.env.PIPLUS_SERVE_WEB === '1') {
  const webRoot = process.env.PIPLUS_WEB_DIST;
  if (webRoot) {
    app.use('/assets/*', serveStatic({ root: webRoot }));
    app.get('*', async (c, next) => {
      const path = c.req.path;
      if (path.startsWith('/api/') || path === '/ws' || path === '/health') {
        await next();
        return;
      }
      return serveStatic({ root: webRoot, path: 'index.html' })(c, next);
    });
  }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`cd apps/api && bun test src/app.test.ts`
预期：PASS

- [ ] **步骤 5：Commit**

```bash
git add apps/api/src/app.ts apps/api/src/app.test.ts
git commit -m "test: cover docker cors and web serving"
```

### 任务 3：编写单容器 Dockerfile 与 compose 配置

**文件：**
- 创建：`Dockerfile`
- 创建：`docker-compose.yml`
- 测试：`docker build -t piplus:local --build-arg PUBLIC_WEB_ORIGIN=http://localhost:3000 .`

- [ ] **步骤 1：编写失败的构建验证命令**

运行：`docker build -t piplus:local --build-arg PUBLIC_WEB_ORIGIN=http://localhost:3000 .`
预期：FAIL，当前仓库中没有 Dockerfile。

- [ ] **步骤 2：编写最少 Dockerfile**

```dockerfile
FROM oven/bun:1 AS builder
WORKDIR /app
COPY package.json bun.lock ./
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./tsconfig.json
RUN bun install
ARG PUBLIC_WEB_ORIGIN
ENV VITE_API_BASE_URL=${PUBLIC_WEB_ORIGIN}
ENV VITE_WS_BASE_URL=${PUBLIC_WEB_ORIGIN}
RUN case "$PUBLIC_WEB_ORIGIN" in \
  https://*) export VITE_WS_BASE_URL="wss://${PUBLIC_WEB_ORIGIN#https://}" ;; \
  http://*) export VITE_WS_BASE_URL="ws://${PUBLIC_WEB_ORIGIN#http://}" ;; \
  *) echo "Unsupported PUBLIC_WEB_ORIGIN: $PUBLIC_WEB_ORIGIN" && exit 1 ;; \
 esac && \
 cd apps/web && bun run build && \
 cd ../api && bun run build:bundle

FROM oven/bun:1 AS runtime
WORKDIR /app
RUN addgroup --system app && adduser --system --ingroup app --home /home/app app
ENV HOME=/home/app
COPY --from=builder /app /app
RUN mkdir -p /home/app/.pi /home/app/.config/piplus && chown -R app:app /app /home/app
USER app
EXPOSE 3000
CMD ["bun", "run", "apps/api/src/index.ts"]
```

- [ ] **步骤 3：编写最少 compose 配置**

```yaml
services:
  piplus:
    build:
      context: .
      args:
        PUBLIC_WEB_ORIGIN: ${PUBLIC_WEB_ORIGIN}
    environment:
      HOME: /home/app
      API_HOST: 0.0.0.0
      API_PORT: 3000
      PUBLIC_WEB_ORIGIN: ${PUBLIC_WEB_ORIGIN}
      PIPLUS_SERVE_WEB: '1'
      PIPLUS_WEB_DIST: /app/apps/web/dist
    ports:
      - "3000:3000"
    volumes:
      - ${HOME}/.pi/agent:/home/app/.pi/agent
      - ${HOME}/.config/piplus:/home/app/.config/piplus
```

- [ ] **步骤 4：运行构建验证通过**

运行：`docker build -t piplus:local --build-arg PUBLIC_WEB_ORIGIN=http://localhost:3000 .`
预期：PASS，镜像构建成功。

- [ ] **步骤 5：Commit**

```bash
git add Dockerfile docker-compose.yml
git commit -m "feat: add docker deployment files"
```

### 任务 4：补充 Docker 部署文档与示例配置

**文件：**
- 创建：`deployment/docker/README.md`
- 创建：`deployment/docker/.env.example`
- 修改：`README.md`
- 测试：`rg -n "PUBLIC_WEB_ORIGIN|docker compose up -d --build|~/.pi/agent|~/.config/piplus" deployment/docker/README.md README.md`

- [ ] **步骤 1：编写失败的文档检查命令**

运行：`rg -n "PUBLIC_WEB_ORIGIN|docker compose up -d --build|~/.pi/agent|~/.config/piplus" deployment/docker/README.md README.md`
预期：FAIL，部署文档与示例配置尚不存在或内容缺失。

- [ ] **步骤 2：编写最少部署文档与示例配置**

```md
# Piplus Docker 部署

## 环境变量

复制 `deployment/docker/.env.example` 为项目根目录 `.env`，至少配置：

```env
PUBLIC_WEB_ORIGIN=https://your-domain.example.com
```

## 启动

```bash
docker compose up -d --build
```

## 数据挂载

- `~/.pi/agent` → `/home/app/.pi/agent`
- `~/.config/piplus` → `/home/app/.config/piplus`

## 变更域名

修改 `PUBLIC_WEB_ORIGIN` 后，必须重新执行：

```bash
docker compose up -d --build
```
```

```env
PUBLIC_WEB_ORIGIN=https://your-domain.example.com
```

- 在 `README.md` 中新增一节：

```md
## Docker 部署

详见 `deployment/docker/README.md`。
```

- [ ] **步骤 3：运行文档检查验证通过**

运行：`rg -n "PUBLIC_WEB_ORIGIN|docker compose up -d --build|~/.pi/agent|~/.config/piplus" deployment/docker/README.md README.md`
预期：PASS，命中文档与 README 中的关键说明。

- [ ] **步骤 4：Commit**

```bash
git add deployment/docker/README.md deployment/docker/.env.example README.md
git commit -m "docs: add docker deployment guide"
```

## 自检

- 规格覆盖度：已覆盖 Dockerfile、compose、单容器、Bun、`PUBLIC_WEB_ORIGIN`、CORS、Pi / Piplus 目录挂载、部署文档。
- 占位符扫描：无 TODO、待定、后续补充等占位词。
- 类型一致性：统一使用 `PUBLIC_WEB_ORIGIN` 作为外部域名来源，前端派生 `VITE_API_BASE_URL` / `VITE_WS_BASE_URL`，后端读取同名变量做 CORS。

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-24-docker-deployment.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？