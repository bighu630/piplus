# Tauri 桌面端打包设计规格

## 日期
2026-07-23

## 概述

新增 Tauri v2 桌面端打包方案，替代 Electron。采用保守方案：Tauri 做壳 + Bun sidecar 运行 API。

## 架构

```
Tauri (Rust)                    Bun sidecar
├─ WebView → loadURL(localhost:18321)
├─ System Tray
├─ Window Management
├─ Sidecar spawn: bun → API process
├─ Health check polling
├─ Config injection (eval)
└─ Notifications
```

## 项目结构

```
apps/desktop-tauri/
├── package.json              # npm scripts
├── src-tauri/
│   ├── Cargo.toml
│   ├── tauri.conf.json       # Tauri v2 配置
│   ├── build.rs              # 构建脚本
│   ├── icons/                # 应用图标
│   ├── src/
│   │   ├── main.rs           # Tauri builder + setup hook
│   │   ├── sidecar.rs        # Bun sidecar 管理（spawn/stop）
│   │   ├── health.rs         # 健康检查轮询 /health
│   │   ├── paths.rs          # 应用数据路径管理
│   │   ├── port.rs           # 端口分配（18321 + fallback）
│   │   ├── tray.rs           # 系统托盘
│   │   ├── config.rs         # window.piplusConfig 注入
│   │   └── logging.rs        # 文件日志
│   └── external/             # 构建时填充的资源
│       ├── bun-bin/          # bun 二进制
│       ├── api-dist/         # API dist
│       ├── web-dist/         # Web dist
│       ├── migrations/       # 数据库迁移
│       └── pty-libs/         # bun-pty native libs
```

## 模块设计

### main.rs
- Tauri builder 配置
- setup hook：
  1. 创建应用目录（data/logs/runtime/cache/projects）
  2. 分配端口（18321 优先，fallback 随机）
  3. spawn Bun sidecar（通过 tauri::process::Command）
  4. 健康检查轮询 /health（15s 超时）
  5. 创建 WebviewWindow，loadURL(localhost:PORT)
  6. eval 注入 window.piplusConfig
  7. 创建系统托盘
- 窗口关闭事件拦截 → hide（不 quit）
- 应用退出时 kill sidecar

### sidecar.rs
- 使用 `tauri::process::Command` API（Tauri sidecar）
- 环境变量传递：
  - API_HOST=127.0.0.1
  - API_PORT=18321
  - PIPLUS_DATA_DIR=<dataDir>
  - DATABASE_URL=file:<dataDir>/app.db
  - PROJECTS_ROOT=<dataDir>/projects
  - PIPLUS_WEB_DIST=<web-dist-path>
  - PIPLUS_SERVE_WEB=1
  - PIPLUS_FORCE_ROLE_PROMPTS=true
  - APP_PASSWORD（可选）
- stdout/stderr → 文件日志 + 控制台
- SIGTERM → 3s → SIGKILL

### health.rs
- 轮询 GET http://127.0.0.1:PORT/health
- 间隔 300ms
- 超时 15s
- 返回 Result，失败时应用退出

### paths.rs
- dataDir: ~/.config/piplus（Linux）或平台对应目录
- logsDir: <dataDir>/logs
- runtimeDir: <dataDir>/runtime
- cacheDir: <dataDir>/cache
- projectsDir: <dataDir>/projects
- databasePath: <dataDir>/app.db

### port.rs
- 优先：环境变量 PIPLUS_DESKTOP_PORT
- 默认：18321
- Fallback：随机可用端口
- 检查端口可用性（TCP bind test）

### tray.rs
- 右键菜单：「显示」「退出」
- 左键点击：恢复窗口
- 图标：复用 apps/desktop/assets/tray-icon.png

### config.rs
- 注入 window.piplusConfig = { isDesktop: true, platform: <os> }
- 通过 webview.eval() 实现
- 前端 runtime-config.ts 零改动

### logging.rs
- 日志文件：<logsDir>/desktop.log
- API 日志：<logsDir>/api.log
- 控制台 + 文件双写

## tauri.conf.json 核心配置

```json
{
  "productName": "piplus",
  "version": "0.2.9",
  "identifier": "com.piplus.desktop",
  "build": {
    "frontendDist": "../external/web-dist",
    "devUrl": "http://localhost:3000",
    "beforeDevCommand": "",
    "beforeBuildCommand": ""
  },
  "app": {
    "windows": [{
      "width": 1440,
      "height": 960,
      "resizable": true,
      "title": "piplus"
    }],
    "security": {
      "csp": "default-src 'self' http://localhost:*; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; font-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*"
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "externalBin": ["external/bun-bin/bun"],
    "resources": [
      "external/api-dist/**",
      "external/web-dist/**",
      "external/migrations/**",
      "external/pty-libs/**"
    ]
  }
}
```

## 构建脚本

`scripts/build-desktop-tauri.sh`：
1. API bundle（`cd apps/api && bun run build:bundle`）
2. Web build（`cd apps/web && bun run build:desktop`）
3. 复制资源到 `apps/desktop-tauri/src-tauri/external/`
4. 复制 bun binary
5. 复制 pty-libs
6. 验证所有资源
7. `cargo tauri build`

## 不动的部分

- ✅ `apps/desktop/`（Electron）完全不动
- ✅ `apps/web/`（React 前端）不改源码
- ✅ `apps/api/`（API 服务）不改
- ✅ `packages/`（共享包）不改

## 验证

```bash
cd apps/desktop-tauri/src-tauri
cargo check    # 编译检查
cargo build    # 完整构建
```

## 约束

- Tauri v2
- Bun sidecar 运行 API（不用 Rust 重写业务逻辑）
- 前端通过 eval 注入配置（零改动 React 代码）
- 固定端口 18321，fallback 随机
- 日志：~/.config/piplus/logs/
- 窗口：1440x960，可调整
- DevTools：环境变量控制
