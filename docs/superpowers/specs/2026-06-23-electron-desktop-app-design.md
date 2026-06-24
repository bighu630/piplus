# piplus Electron 本地桌面应用（方案一）设计

> 在不影响现有 `apps/web` 与 `apps/api` 独立开发、独立启动方式的前提下，为 piplus 增加一个基于 Electron 的本地桌面壳。桌面态采用「Electron 主进程 + 内嵌本地 API + 现有前端继续通过 fetch / WebSocket 访问本地 API」的路线。

## 目标

本次改造的目标不是重写前后端架构，而是在现有仓库上新增一层桌面运行形态：

1. `apps/api` 继续保持当前后端职责与独立启动能力。
2. `apps/web` 继续保持当前前端职责与独立启动能力。
3. 新增 `apps/desktop`，由 Electron 主进程负责启动本地 API、注入运行时配置、创建桌面窗口与打包分发。
4. 前端在桌面态下继续使用 `fetch` 与 `WebSocket` 访问本地 API，不改造成 IPC-only 架构。
5. 应用数据统一收敛到平台标准应用数据目录下的 `piplus` 目录。

## 范围

本设计覆盖以下范围：

- `apps/web`：前端运行时配置接入、桌面态 API 地址获取方式
- `apps/api`：桌面兼容最小改造、监听地址与数据目录收敛
- `apps/desktop`：Electron 主进程、preload、开发脚本、打包配置
- `packaging`：三平台桌面分发方案与分阶段实施路径

不在本次范围内的内容：

- 将现有 API 全量改写为 Electron IPC
- 一期内将 `apps/api` 从 Bun 全量迁移到 Node 兼容运行时
- 一期内重做登录协议或引入系统级单点登录
- 一期内引入自动更新、签名、公证等发布后期能力

## 已确认约束

以下约束已与用户确认：

1. **不能影响现有前后端架构与启动方式。** 也就是说，`apps/api` 仍可单独通过 Bun 启动，`apps/web` 仍可单独通过现有方式启动。
2. **前端获取 API 地址采用双通道策略。** 开发态 / 网页态继续使用环境变量；Electron 桌面态通过 `preload` 注入。
3. **Electron 桌面态不使用固定端口。** 每次启动时动态分配本地空闲端口，避免与机器上其他服务冲突。
4. **一期继续保留本地密码登录。** 不改现有认证协议与登录流程。

## 方案概览

整体采用三层结构：

```text
Electron Main
  ├─ 计算数据目录
  ├─ 申请本地动态端口
  ├─ 启动 API 子进程（Bun）
  ├─ 等待 /health 就绪
  ├─ 创建 BrowserWindow
  └─ 通过 preload 注入 runtime config

Renderer（apps/web）
  ├─ 从 runtime config 读取 apiBaseUrl / wsBaseUrl
  ├─ 继续通过 fetch 访问 HTTP API
  └─ 继续通过 WebSocket 访问 /ws

Local API（apps/api）
  ├─ Hono HTTP API
  ├─ WebSocket /ws
  ├─ 本地认证
  └─ 数据库存储 / 会话运行 / Pi Runtime 集成
```

这个结构的核心思想是：**桌面应用只是增加一层宿主，不改变现有 Web 与 API 的业务边界。**

## 方案对比

### 方案 A：Electron 主进程 + API 子进程 + Web fetch / WS（推荐）

做法：

- Electron `main` 用 `child_process.spawn()` 启动 `apps/api`
- `apps/api` 仍以本地 HTTP + WebSocket 服务存在
- `apps/web` 继续通过 URL 访问 API

优点：

- 对现有代码侵入最小
- 保持前后端边界清晰
- 保留独立开发与独立调试能力
- 最符合本次「不影响现有架构」的约束
- 一期落地速度最快

缺点：

- 桌面态存在 Electron + Bun 双运行时
- 打包时需要携带 API 运行时与资源

### 方案 B：Electron 主进程内联 API

做法：

- 在 Electron `main` 内直接 `import` API 启动逻辑
- 不再通过单独子进程运行 API

优点：

- 进程数更少

缺点：

- 和现有独立后端入口边界冲突
- 崩溃隔离变差
- 如果继续保留 Bun，将很难在 Electron 主进程中自然内嵌运行
- 不利于后续维护与日志排障

### 方案 C：Renderer 改为 IPC-only

做法：

- 前端不再使用 HTTP / WS
- 所有能力改成 `preload + ipcRenderer + ipcMain`

优点：

- 理论上可减少本地开放端口

缺点：

- 改造面过大
- 与本次已确认路线不一致
- 会破坏现有前后端边界与开发方式

### 结论

采用 **方案 A**。

## 运行时选择

### 一期决策：保留 Bun API

当前 `apps/api` 已显式依赖 Bun：

- `Bun.serve`
- `Bun.env`
- `bun test`
- 现有开发脚本基于 Bun

为了不影响现有后端开发模式，一期不迁移 API 运行时，继续保持：

- Electron 主进程：Node / Electron 运行时
- API 子进程：Bun 运行时

### 二期方向：评估迁移到 Node 兼容

长期来看，统一到 Node 兼容运行时会让打包更简单、平台适配更轻，但这不应阻塞桌面版一期落地。二期再评估：

- `Bun.env` → `process.env`
- `Bun.serve` → Node 兼容 HTTP server
- `bun test` 的迁移或兼容策略

## 详细架构设计

### 一、Electron 主进程职责

`apps/desktop` 中的 Electron 主进程负责以下职责：

1. 计算当前平台的数据目录路径。
2. 申请一个仅监听 `127.0.0.1` 的动态空闲端口。
3. 生成并注入 API 启动环境变量。
4. 启动 `apps/api` Bun 子进程。
5. 轮询 `GET /health`，确认本地 API 已就绪。
6. 创建 `BrowserWindow`。
7. 将 `apiBaseUrl`、`wsBaseUrl`、平台信息等通过 `preload` 暴露给 renderer。
8. 监听 API 子进程退出并做日志记录；一期先不做复杂自动重启策略，但保留扩展点。
9. 在应用退出时清理 API 子进程。

### 二、API 子进程职责

`apps/api` 一期只做桌面兼容的最小改动，不改业务协议：

1. 继续暴露现有 HTTP API。
2. 继续暴露现有 WebSocket `/ws`。
3. 继续使用当前本地密码登录方案。
4. 从显式环境变量中读取数据库路径、数据目录、端口等运行参数。
5. 收敛监听地址为 `127.0.0.1`，避免桌面态误暴露到局域网。

### 三、Renderer 职责

`apps/web` 维持原有职责，仅新增统一配置读取层：

1. 优先从 `window.piplusConfig` 读取桌面态注入配置。
2. 若不存在桌面注入，则回退到 `import.meta.env` 读取开发态配置。
3. 前端其余模块统一从一个配置入口获取 `apiBaseUrl` 与 `wsBaseUrl`。
4. 现有 API 调用、WebSocket 调用、鉴权逻辑尽量不改。

## 启动时序

桌面态启动链路如下：

```text
用户启动 Electron 应用
  → main 计算数据目录
  → main 申请动态端口
  → main 准备环境变量
  → main spawn Bun API 子进程
  → API 绑定 127.0.0.1:<dynamic-port>
  → main 轮询 GET /health
  → health 成功
  → main 创建 BrowserWindow
  → preload 注入 runtime config
  → renderer 启动并读取 apiBaseUrl / wsBaseUrl
  → 前端正常进行 fetch / WebSocket 通信
```

### readiness 策略

桌面态不能在 API 尚未 ready 时立即加载前端后期待其自行重试，否则会出现首屏空白、登录失败或 WebSocket 连接报错等问题。因此一期应采用：

- `main` 启动 API 后轮询 `/health`
- 成功后再创建主窗口
- 若超时，则展示错误页或错误对话框并允许用户退出

### 退出策略

- Electron 退出时，由 `main` 主动终止 API 子进程
- API 子进程退出事件要写入日志
- 一期如果 API 异常退出，可以提示用户「本地服务已停止，请重启应用」
- 自动重启可以作为二期增强项

## 前端运行时配置设计

### 配置来源

前端配置分为两种来源：

#### 1. 网页态 / 开发态

继续使用 Vite 环境变量，例如：

- `VITE_API_BASE_URL`
- `VITE_WS_BASE_URL`

#### 2. Electron 桌面态

由 `preload` 注入只读配置对象，例如：

```ts
window.piplusConfig = {
  isDesktop: true,
  apiBaseUrl: 'http://127.0.0.1:43127',
  wsBaseUrl: 'ws://127.0.0.1:43127',
  platform: 'darwin'
}
```

### 前端统一读取入口

建议在 `apps/web` 中新增一层例如：

- `src/lib/runtime-config.ts`

职责：

- 读取 `window.piplusConfig`
- 回退到 `import.meta.env`
- 输出统一的：
  - `apiBaseUrl`
  - `wsBaseUrl`
  - `isDesktop`

这样可确保：

- URL 拼接逻辑不散落在多个模块中
- 动态端口对前端完全透明
- `apps/web` 在浏览器模式下仍可正常工作

## 本地数据目录设计

### 目标

统一使用平台标准应用数据目录，并在其中创建 `piplus` 目录。

### 各平台路径

- macOS：`~/Library/Application Support/piplus`
- Linux：`~/.config/piplus`
- Windows：`%APPDATA%/piplus`

虽然用户提到 `~/.config/piplus`，但在实现层面应遵循各平台的标准应用数据目录习惯，以避免与平台生态冲突。

### 建议目录结构

```text
piplus/
  app.db
  logs/
  runtime/
  cache/
  projects/
  config.json
```

可选扩展：

- `auth.json`：若后续需要额外持久化本地认证状态
- `crash/`：若后续需要桌面崩溃诊断数据

### 传递方式

数据目录由 Electron `main` 统一计算，再通过环境变量传给 API：

- `PIPLUS_DATA_DIR=<平台标准路径>/piplus`
- `DATABASE_URL=file:<PIPLUS_DATA_DIR>/app.db`

这样可确保：

- 桌面态与网页态可以拥有不同的数据目录策略
- `apps/api` 不必依赖 Electron API
- 数据路径决策集中在桌面壳层

## WebSocket 设计

### 一期决策：保留本地 WebSocket

继续保留：

- `ws://127.0.0.1:<dynamic-port>/ws`

原因：

1. 当前后端已具备 WebSocket 协议与实现。
2. 前端现有实时交互无需改造成 IPC。
3. HTTP 与 WS 共用同一主机与端口，心智模型清晰。
4. 调试与抓日志都更简单。

### 安全边界

为了降低本地开放端口的风险，一期必须约束：

- 仅监听 `127.0.0.1`
- 不监听 `0.0.0.0`
- 端口由主进程动态分配
- renderer 不自行推测地址，只使用注入配置

## 登录与认证设计

### 一期决策：保留本地密码登录

继续保留现有：

- `POST /api/v1/auth/login`
- 本地密码校验
- token 返回与登录态检查流程

### 保留原因

1. 与现有前后端协议完全兼容。
2. 避免桌面化同时重构认证，降低首期风险。
3. 可以先验证桌面壳、数据目录、打包分发等核心问题。

### 后续演进空间

二期可以再评估：

- 首次启动引导设置本地密码
- 与系统钥匙串集成
- 自动解锁或免登录体验
- token 的更安全存储方式

但这些都不应进入一期范围。

## 平台与打包设计

### 目标平台

最终目标平台为：

- macOS
- Windows
- Linux

### 实施顺序

建议按以下顺序推进：

1. macOS
2. Linux
3. Windows

原因：

- 当前 Bun + Electron 子进程模式在类 Unix 环境更容易先跑通
- Windows 在路径、进程参数、二进制打包与 SQLite 文件占用方面通常会有额外适配工作

### 打包工具选择

推荐使用：

- `electron-builder`

原因：

1. 三平台产物支持成熟。
2. 对额外二进制、资源目录、安装包配置支持较完善。
3. 更适合携带 Bun runtime、API bundle 与桌面资源。

不优先选择 `electron-forge`，因为本项目的重点不是简单壳应用，而是包含本地 API 运行时与资源打包的桌面分发场景。

## 建议目录结构

建议新增：

```text
apps/
  api/
  web/
  desktop/
    package.json
    tsconfig.json
    src/
      main/
        index.ts           # Electron 主入口
        api-process.ts     # 启动 / 停止 API 子进程
        port.ts            # 动态端口申请
        paths.ts           # 平台数据目录计算
        health.ts          # /health 等待逻辑
        window.ts          # BrowserWindow 创建
      preload/
        index.ts           # 暴露 piplusConfig
    build/
      icons/
    electron-builder.yml   # 或 package.json 中的 build 配置
```

现有目录的最小改动建议：

```text
apps/web/src/
  lib/
    runtime-config.ts      # 新增：统一读取 apiBaseUrl / wsBaseUrl

apps/api/src/
  index.ts                 # 可能最小改造：host / port / env 读取收敛
  config/                  # 若现有配置分散，可新增桌面相关配置读取
```

## 模块职责划分

### `apps/desktop/src/main/paths.ts`

负责：

- 根据平台计算标准应用数据目录
- 确保 `piplus` 目录存在
- 提供数据库、日志、缓存等子路径

### `apps/desktop/src/main/port.ts`

负责：

- 申请动态空闲端口
- 返回最终用于 API 的本地端口

### `apps/desktop/src/main/api-process.ts`

负责：

- 组织 API 启动命令
- 注入环境变量
- 管理子进程 stdout / stderr
- 提供 stop / cleanup 能力

### `apps/desktop/src/main/health.ts`

负责：

- 轮询 `GET /health`
- 控制超时与重试间隔
- 在超时时返回结构化错误

### `apps/desktop/src/main/window.ts`

负责：

- 创建 `BrowserWindow`
- 加载开发态 URL 或生产态 `index.html`
- 设置安全相关选项，如 `contextIsolation`

### `apps/desktop/src/preload/index.ts`

负责：

- 通过 `contextBridge` 暴露只读的 `piplusConfig`
- 不直接暴露高权限 Node 能力

### `apps/web/src/lib/runtime-config.ts`

负责：

- 统一封装配置获取逻辑
- 给 API client、WS client 提供单一入口

## 开发模式设计

为了保持现有前后端开发体验，一期建议支持至少两种开发模式：

### 模式 1：现有 Web/API 分离开发模式

- 开发者手动启动 `apps/api`
- 开发者手动启动 `apps/web`
- 与当前体验保持一致

### 模式 2：Electron 桌面开发模式

- Electron 主进程启动 API 子进程
- renderer 在开发态可加载 `apps/web` 的 dev server
- 使用 `preload` 注入本地 API 地址

这样可以满足：

- 不破坏当前开发流
- 又能验证桌面态真实集成链路

## 错误处理设计

### API 启动失败

场景：

- Bun 不存在
- 启动命令错误
- 数据目录不可写
- 数据库初始化失败

处理：

- `main` 捕获子进程退出或启动超时
- 展示明确错误对话框
- 日志写入桌面应用日志目录

### API readiness 超时

场景：

- 进程已启动，但 `/health` 长时间不可用

处理：

- 终止子进程
- 给用户展示错误说明
- 提示查看日志或重试

### renderer 配置缺失

场景：

- preload 未注入
- 环境变量也未设置

处理：

- 在前端统一配置层抛出明确错误
- 不允许多个业务模块各自静默失败

## 测试与验证策略

### 一期需要覆盖的验证点

#### 桌面链路

1. Electron 主进程能成功申请动态端口。
2. Electron 主进程能成功拉起 API 子进程。
3. `/health` ready 后窗口再打开。
4. 应用退出时 API 子进程能被正确回收。

#### 前端配置链路

1. 桌面态能正确读取 `window.piplusConfig`。
2. 网页态仍能正确读取 `VITE_*` 配置。
3. API client 与 WS client 都经过统一配置层取地址。

#### API 桌面兼容链路

1. API 能监听 `127.0.0.1`。
2. API 能从环境变量读取数据目录与数据库路径。
3. 本地密码登录仍可正常工作。
4. WebSocket `/ws` 在桌面态仍可连接与通信。

#### 数据目录链路

1. 各平台能正确创建 `piplus` 数据目录。
2. 数据库文件落在预期目录。
3. 应用重启后数据可复用。

## 分阶段实施计划

### Phase 1：桌面 MVP

目标：在不改现有 Web/API 架构的前提下，跑通 macOS 桌面版。

内容：

1. 新增 `apps/desktop`
2. Electron `main` 动态端口申请
3. Bun API 子进程拉起
4. `/health` 等待
5. `preload` 注入 runtime config
6. `apps/web` 接入 runtime config
7. `apps/api` 收敛 host / data dir / env 读取
8. 使用 `electron-builder` 生成首个可运行桌面包

### Phase 2：工程化增强

目标：让桌面态更稳定、更适合团队开发与测试。

内容：

1. 日志归档与查看策略
2. API 异常退出提示与更稳的恢复策略
3. 桌面开发脚本完善
4. 首次启动初始化体验
5. 更细的错误提示页

### Phase 3：运行时收敛评估

目标：评估是否将 API 逐步迁移到 Node 兼容运行时。

内容：

1. 清理 Bun 专属依赖点
2. 抽象 server 启动适配层
3. 评估测试工具链迁移成本

### Phase 4：三平台发布验证

目标：完成 Linux / Windows 的打包与验证。

内容：

1. Linux 路径与安装包验证
2. Windows 路径、子进程、SQLite 文件占用验证
3. 安装、启动、升级、卸载链路验证

## 关键设计结论

1. **新增 `apps/desktop`，而不是重写 `apps/web` 或 `apps/api`。**
2. **Electron 主进程以子进程方式启动本地 API。**
3. **一期继续保留 Bun 作为 API 运行时。**
4. **前端通过 preload 注入读取桌面态 `apiBaseUrl` / `wsBaseUrl`。**
5. **Electron 桌面态始终使用动态端口。**
6. **本地数据目录统一为平台标准 app data 下的 `piplus`。**
7. **WebSocket 继续保留 `ws://127.0.0.1:<dynamic-port>/ws`。**
8. **登录认证一期继续保留本地密码。**
9. **打包工具选择 `electron-builder`。**
10. **实施顺序为 macOS → Linux → Windows。**

## 待进入实现计划时需要进一步细化的点

以下事项已足够支撑实现计划，但在写实施计划时需要落到具体文件与命令级别：

1. `apps/desktop` 的包管理方式与脚本命名
2. 开发态 Electron 如何连接 `apps/web` dev server
3. Bun 可执行文件在开发态与打包态的定位方式
4. `apps/api` 中数据目录与数据库路径的具体配置落点
5. `apps/web` 中现有 API / WS client 的统一接入改造点
6. `electron-builder` 的资源复制策略与产物结构
