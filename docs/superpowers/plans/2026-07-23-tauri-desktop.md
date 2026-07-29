# Tauri 桌面端打包实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 `apps/desktop-tauri/` 下创建 Tauri v2 桌面壳，Bun sidecar 运行现有 API，功能对齐现有 Electron 方案。

**架构：** Tauri (Rust) 作为桌面壳，通过 std::process::Command spawn bun 运行 API sidecar。API 同时 serve web 前端。WebView 加载 localhost:18321。window.piplusConfig 通过 webview eval 注入。

**技术栈：** Tauri v2, Rust, serde, reqwest (health check), tokio

**工作目录：** `/data/code/piplus/.worktrees/tauri-desktop/`

---

## 文件结构

```
apps/desktop-tauri/
├── package.json
├── src-tauri/
│   ├── Cargo.toml
│   ├── build.rs
│   ├── tauri.conf.json
│   ├── icons/                    # 从 apps/desktop/assets/ 生成
│   ├── src/
│   │   ├── main.rs               # Tauri builder + setup hook + 事件处理
│   │   ├── sidecar.rs            # Bun sidecar spawn/stop
│   │   ├── health.rs             # GET /health 轮询
│   │   ├── paths.rs              # 应用数据目录管理
│   │   ├── port.rs               # 端口分配
│   │   ├── tray.rs               # 系统托盘
│   │   ├── config.rs             # window.piplusConfig 注入
│   │   └── logging.rs            # 文件日志
│   └── external/                 # 构建时填充
```

---

## Task 1：Rust 源码实现

**文件：**
- 创建：`apps/desktop-tauri/package.json`
- 创建：`apps/desktop-tauri/src-tauri/Cargo.toml`
- 创建：`apps/desktop-tauri/src-tauri/build.rs`
- 创建：`apps/desktop-tauri/src-tauri/tauri.conf.json`
- 创建：`apps/desktop-tauri/src-tauri/src/main.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/sidecar.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/health.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/paths.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/port.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/tray.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/config.rs`
- 创建：`apps/desktop-tauri/src-tauri/src/logging.rs`

### 模块接口契约（所有模块必须遵循）

```rust
// paths.rs
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub logs_dir: PathBuf,
    pub runtime_dir: PathBuf,
    pub cache_dir: PathBuf,
    pub projects_dir: PathBuf,
    pub database_path: PathBuf,
}
pub async fn ensure_app_paths() -> Result<AppPaths, Box<dyn std::error::Error>>

// port.rs
pub const DEFAULT_API_PORT: u16 = 18321;
pub async fn get_preferred_port(host: &str) -> Result<(u16, bool), Box<dyn std::error::Error>>
pub async fn get_free_port(host: &str) -> Result<u16, Box<dyn std::error::Error>>
pub async fn is_port_available(host: &str, port: u16) -> bool

// sidecar.rs
pub struct SidecarHandle { child: Option<Child> }
pub struct SidecarConfig { port: u16, paths: AppPaths, app_password: Option<String>, bun_path: PathBuf, api_entry: String, api_cwd: String, web_dist_dir: String }
impl SidecarHandle {
    pub fn start(config: SidecarConfig) -> Result<Self, Box<dyn std::error::Error>>
    pub fn stop(&mut self)
}

// health.rs
pub async fn wait_for_health(url: &str, timeout_ms: u64) -> Result<(), Box<dyn std::error::Error>>

// tray.rs
pub fn setup_tray(app: &tauri::AppHandle, icon_path: &Path) -> Result<(), Box<dyn std::error::Error>>

// config.rs
pub fn inject_config(webview: &tauri::Webview, platform: &str) -> Result<(), Box<dyn std::error::Error>>

// logging.rs
pub struct FileLogger { log_path: PathBuf }
impl FileLogger {
    pub fn new(logs_dir: &Path, filename: &str) -> Self
    pub fn write_log(&self, line: &str)
}
```

### 详细实现要求

#### Cargo.toml
```toml
[package]
name = "piplus-desktop"
version = "0.2.9"
edition = "2021"

[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
tauri-build = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", features = ["blocking"] }
tokio = { version = "1", features = ["full"] }

[build-dependencies]
tauri-build = { version = "2", features = [] }

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

#### tauri.conf.json 核心配置
- productName: "piplus"
- version: "0.2.9"
- identifier: "com.piplus.desktop"
- build.frontendDist: "../external/web-dist"
- build.devUrl: "http://localhost:3000"
- app.windows: [{ width: 1440, height: 960, resizable: true, title: "piplus" }]
- app.security.csp: "default-src 'self' http://localhost:*; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; font-src 'self' data:; connect-src 'self' http://localhost:* ws://localhost:*"
- bundle.resources: ["external/api-dist/**", "external/web-dist/**", "external/migrations/**", "external/pty-libs/**"]
- bundle.externalBin: ["external/bun-bin/bun"]
- bundle.icon: ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.icns", "icons/icon.ico"]

#### main.rs 核心逻辑
```
fn main():
  1. tauri::Builder::default()
  2. .setup(|app| {
     a. ensure_app_paths() → AppPaths
     b. get_preferred_port("127.0.0.1") → (port, preferred)
     c. 构造 SidecarConfig，设置环境变量
     d. SidecarHandle::start(config)
     e. wait_for_health(&format!("http://127.0.0.1:{}/health", port), 15000)
     f. 创建 WebviewWindow，loadURL(format!("http://127.0.0.1:{}", port))
     g. inject_config(webview, os_platform)
     h. setup_tray(app.handle(), icon_path)
     i. 将 sidecar handle 存入 app.manage()
     j. Ok(())
  })
  3. .on_window_event(|window, event| {
     match event:
       CloseRequested → event.prevent(); window.hide()
  })
  4. .build(tauri::generate_context!())
  5. .run(|app, event| {
     match event:
       Exit → 从 managed state 取 sidecar handle，stop
  })
```

#### sidecar.rs - Bun Sidecar 管理
- 使用 `std::process::Command` spawn bun 进程
- bun 路径解析：
  - 环境变量 PIPLUS_BUN_PATH 优先
  - 否则从 Tauri resource 路径解析 `resolve_resource("external/bun-bin/bun")`
  - fallback: "bun"（系统 PATH）
- API 入口：
  - dev: `<repo_root>/apps/api/src/index.ts`
  - prod: `<resource_dir>/external/api-dist/index.js`
- 环境变量（与 Electron 版完全对齐）：
  - API_HOST=127.0.0.1
  - API_PORT=<port>
  - PIPLUS_DATA_DIR=<data_dir>
  - DATABASE_URL=file:<database_path>
  - PROJECTS_ROOT=<projects_dir>
  - PIPLUS_WEB_DIST=<web_dist_dir>
  - PIPLUS_SERVE_WEB=1
  - PIPLUS_FORCE_ROLE_PROMPTS=true
  - APP_PASSWORD（可选）
- stdout/stderr 同时输出到控制台和文件日志
- stop(): SIGTERM → 3s timeout → SIGKILL

#### health.rs
- 轮询 GET http://127.0.0.1:PORT/health
- 间隔 300ms
- 超时 15000ms
- 使用 reqwest::blocking::get 或 async client
- 返回 Result<(), Error>

#### paths.rs
- Linux: `~/.config/piplus/` 或 XDG_DATA_HOME
- macOS: `~/Library/Application Support/piplus/`
- Windows: `%APPDATA%/piplus/`
- 使用 `dirs` crate 或硬编码 `$HOME/.config/piplus`
- 创建子目录：logs, runtime, cache, projects
- database_path: `<data_dir>/app.db`

#### port.rs
- 优先级：PIPLUS_DESKTOP_PORT env → 18321 → 随机
- is_port_available: TcpListener::bind 测试
- get_free_port: TcpListener::bind("127.0.0.1:0") 获取系统分配端口

#### tray.rs
- 使用 Tauri v2 TrayIcon API
- 右键菜单：显示（restore window）、退出（quit app）
- 左键：恢复窗口
- 图标路径：从 resource 目录解析

#### config.rs
- webview.eval("window.piplusConfig = { isDesktop: true, platform: '<os>' }")
- platform: "linux" | "darwin" | "windows"

#### logging.rs
- 写入 `<logs_dir>/desktop.log` 和 `<logs_dir>/api.log`
- 带时间戳前缀
- 同时输出到 stdout/stderr

---

## Task 2：构建基础设施

**文件：**
- 创建：`scripts/build-desktop-tauri.sh`
- 创建：`apps/desktop-tauri/src-tauri/external/` 目录结构（空目录）
- 复制：`apps/desktop/assets/tray-icon.png` → `apps/desktop-tauri/src-tauri/icons/tray-icon.png`

### build-desktop-tauri.sh
参照现有 `scripts/build-desktop.sh` 的模式：

1. API bundle: `cd apps/api && bun run build:bundle`
2. Web build: `cd apps/web && APP_VERSION=x.y.z bun run build:desktop`
3. 清理并创建 `apps/desktop-tauri/src-tauri/external/` 子目录
4. 复制资源：
   - `apps/api/dist/*` → `external/api-dist/`
   - `apps/web/dist/*` → `external/web-dist/`
   - `apps/migrations/*` → `external/migrations/`
   - bun binary → `external/bun-bin/bun`
   - pty-libs → `external/pty-libs/`
5. 验证所有资源存在
6. 生成 Tauri 图标（如果缺失）：`cargo tauri icon <source-png>`
7. `cd apps/desktop-tauri/src-tauri && cargo build`

---

## Task 3：编译验证

**目标：** `cargo check` 和 `cargo build` 通过

1. `cd apps/desktop-tauri/src-tauri && cargo check`
2. 修复编译错误
3. `cargo build`
4. 确认无编译错误

---

## 分派策略

- **Worker A**（Rust 源码）: Task 1 — 创建所有 Rust 源文件和配置文件
- **Worker B**（构建基础设施）: Task 2 — 创建构建脚本和资源目录
- **Worker A + B 完成后**：Task 3 — 编译验证（由主会话或 worker 执行）

Worker A 和 B 无文件冲突，可完全并行。
