# Electron Desktop MVP 验证

本文档用于验证 piplus 的 Electron 本地桌面应用（方案一）在当前阶段是否达到 MVP 标准。

## 当前范围

本轮验证覆盖：

- `apps/web` 生产构建产物可生成
- `apps/api` 支持桌面态 host / port / data dir 配置
- `apps/desktop` 主进程 / preload / 本地 API 启动链路可通过类型检查与构建
- Electron 桌面态支持动态端口、预留本地数据目录与 runtime config 注入

当前**不包含**：

- Windows 打包验证
- Linux 打包验证
- Electron 安装包签名、公证、自动更新
- Bun runtime 进入最终安装包后的真实路径验证

## 预期目录与命令

### 关键目录

- 前端构建产物：`apps/web/dist`
- 桌面构建产物：`apps/desktop/dist`
- 设计稿：`docs/superpowers/specs/2026-06-23-electron-desktop-app-design.md`
- 实现计划：`docs/superpowers/plans/2026-06-23-electron-desktop-app-plan.md`

### 推荐执行顺序

1. `cd apps/web && bun run build`
2. `cd apps/api && bun run typecheck`
3. `cd apps/desktop && bun run typecheck`
4. `cd apps/desktop && bun run build`
5. `cd apps/desktop && bun run dev:check`
6. `cd apps/desktop && bun run dev`

## 已完成验证

以下命令在当前仓库已验证通过：

### Web

```bash
cd apps/web && bun run lint
cd apps/web && bun run build
```

预期：

- `apps/web/dist/index.html` 存在
- `dist/assets/*` 正常输出

### API

```bash
cd apps/api && bun run typecheck
cd apps/api && bun test src/server-config.test.ts
```

预期：

- API 类型检查通过
- `server-config` 能正确解析：
  - `API_HOST`
  - `API_PORT`
  - `PIPLUS_DATA_DIR`
  - `DATABASE_URL`
  - `PROJECTS_ROOT`

### Desktop

```bash
cd apps/desktop && bun run typecheck
cd apps/desktop && bun run build
cd apps/desktop && bun run dev:check
```

预期：

- TypeScript 编译通过
- `apps/desktop/dist/main/index.js` 与 `apps/desktop/dist/preload/index.js` 生成
- `dev:check` 输出 `dev-check passed`

## 手工联调检查项

### 1. Electron 前置检查

运行：

```bash
cd apps/desktop && bun run dev:check
```

检查：

- Electron 二进制已正确安装
- `apps/web/dist/index.html` 已存在，或已设置 `PIPLUS_WEB_DEV_URL`

### 2. Electron 桌面启动

运行：

```bash
cd apps/desktop && bun run dev
```

预期：

- Electron 主进程启动
- 本地 API 子进程被拉起
- API 监听地址为 `127.0.0.1:<dynamic-port>`
- `/health` 就绪后再创建窗口
- renderer 能获得：
  - `window.piplusConfig.apiBaseUrl`
  - `window.piplusConfig.wsBaseUrl`

### 3. 登录验证

在桌面窗口中检查：

- 本地密码登录页可打开
- 登录请求指向本地 API
- 登录成功后进入主界面

### 4. WebSocket 验证

检查：

- renderer 通过 `ws://127.0.0.1:<dynamic-port>/ws` 建立连接
- 打开一个已有 session 时，实时事件能正常流入

### 5. 数据目录验证

检查平台标准应用数据目录下是否创建 `piplus`：

- macOS：`~/Library/Application Support/piplus`
- Linux：`~/.config/piplus`
- Windows：`%APPDATA%/piplus`

目录内预期至少包含：

- `app.db`
- `projects/`
- `logs/`
- `runtime/`
- `cache/`

## 已知问题

### 1. 当前环境中的 Electron 二进制未正确安装

现象：

```text
Electron failed to install correctly
```

原因：

- `electron` npm 包存在，但 `electron/dist` 二进制目录缺失
- 这是当前机器的依赖安装问题，不是本次桌面化代码逻辑问题

### 2. `apps/api` 存在一个与本次改造无关的现有测试失败

文件：`apps/api/src/routes/realtime.test.ts`

说明：

- 失败点与本次桌面化改造无直接关系
- 本轮仅修复了与桌面配置收敛直接相关的 `server-config` 测试

## Electron 环境修复建议

如果 `cd apps/desktop && bun run dev` 因 Electron 安装问题失败，可尝试：

### 方案 1：重装 Electron 依赖

```bash
rm -rf node_modules/.bun/electron@*
bun install
```

然后检查：

```bash
find node_modules -path '*electron/dist*'
```

预期：应能看到 Electron 的 `dist` 目录与平台二进制。

### 方案 2：删除 `node_modules` 后全量重装

```bash
rm -rf node_modules bun.lock
bun install
```

适用于依赖状态已损坏、局部重装无效的情况。

### 方案 3：使用开发态前端服务联调

如果不想依赖 `apps/web/dist`，可以先起前端 dev server：

```bash
cd apps/web && bun run dev
```

再在另一个终端：

```bash
PIPLUS_WEB_DEV_URL=http://127.0.0.1:3000 cd apps/desktop && bun run dev
```

注意：不同 shell 对环境变量前缀写法可能略有差异，必要时可先 `export PIPLUS_WEB_DEV_URL=...` 再执行命令。

## MVP 验收标准

满足以下条件即可认为当前阶段达到桌面 MVP：

1. `apps/web` 能生成生产构建产物
2. `apps/api` 能通过 env 接收 host / port / data dir / database 配置
3. `apps/desktop` 能通过类型检查与构建
4. Electron 主进程能：
   - 动态分配端口
   - 启动本地 API
   - 等待 `/health`
   - 注入 runtime config
5. renderer 继续通过 `fetch` / `WebSocket` 使用本地 API
6. 不破坏现有 `apps/web` 与 `apps/api` 独立开发方式

## 后续建议

下一阶段优先做：

1. 修复本机 Electron 安装并完成真实起窗联调
2. 明确 Bun runtime 在桌面打包产物中的携带方式
3. 补齐 `electron-builder` 的真实打包资源路径
4. 评估桌面态首次启动体验与错误提示页
