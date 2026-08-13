# bun build --compile 集成（去掉 bun-bin / pty-libs）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桌面端改为直接运行 `bun build --compile` 产出的单文件 API 二进制，彻底去掉 bun-bin（拷贝 bun 可执行文件）与 pty-libs（复制原生库）机制，并修复扩展加载 ResolveMessage 问题。

**Architecture:** API 从源码编译为单文件二进制（pty 原生库嵌入 bunfs，完全自包含）；desktop spawn 直接执行该二进制；migrations SQL 仍走 extraResources 磁盘文件（二进制内 import.meta.dir 是虚拟路径，findMigrationFile 已加 process.execPath 候选）。win/mac 用 `--target=bun-windows-x64` / `bun-darwin-*` 交叉编译。

**Tech Stack:** bun build --compile（1.3.14，已验证）、electron-builder 26、bash 构建脚本、TypeScript 5/6。

**已验证事实（前置探索结论，不再重复验证）：**
- `bun build --compile src/index.ts` → 87MB 单文件，能完整启动（seed DB → HTTP → web UI 200 → pty spawn bash 正常）
- 必须从源码编译（编译预打包 api-dist/index.js 会 pty 加载失败）
- api 进程内无 spawn bun 调用（只有 git execSync）
- SDK（@earendil-works/pi-coding-agent）extension loader 有专门为编译二进制设计的 `VIRTUAL_MODULES` 机制（`dist/core/extensions/loader.js` 注释原文："These MUST be static so Bun bundles them into the compiled binary"）；当前 bun+index.js 方式走 jiti aliases 分支（`import.meta.resolve` 解析出 `/tmp/.mount_*/index.js` 错误路径 → ResolveMessage）。编译二进制 `import.meta.url` 含 `$bunfs` → `isBunBinary=true` → 走 VIRTUAL_MODULES 分支，扩展加载修复。
- 交叉编译已验证：`--target=bun-windows-x64` → PE32+ exe（111MB）；`--target=bun-darwin-x64` → Mach-O x86_64（82MB），均从 Linux 主机成功。
- 实时实例（port 18321）装有 4 个扩展（pi-superpowers、pi-web-access、pi-fff、pi-rtk-optimizer），日志已有 ResolveMessage 错误 → 可实测验证。
- apps/migrations/ 为 git 跟踪目录（0001/0004/0005）；build:bundle 只同步 0001（保持此行为）。
- .worktrees/ 已 gitignore ✓；pty-libs/、dist 已 gitignore；bun-bin/ 未 ignore 也未跟踪。

**关键决策（已定，不阻塞）：**
- api-dist extraResources **删除**（唯一消费者是桌面 spawn 的 getApiEntryPath）
- bun-bin / pty-libs extraResources **删除**；scripts/copy-pty-libs.sh **删除**
- win/mac 同步改为 --target 交叉编译（CI：win 在 ubuntu 上、mac 在 macos runner 上）
- Linux 目标：**musl**（`--target=bun-linux-x64-musl`，跨发行版兼容），Task 11 验证 musl+pty；若不通过则退回 host target 并在脚本注释说明
- build:bundle 保留给调试（去掉 copy-pty-libs.sh 调用）
- 迁移文件：二进制放置于 `resources/bin/`，migrations 在 `resources/migrations/`，init.ts 的 `dirname(process.execPath)/../migrations` 候选命中
- 开发模式（dev）不变：bun + src/index.ts

---

### Task 1: Git 分支与隔离工作区

**Files:** 无（git 操作）

- [ ] **Step 1: 提交 init.ts（已在主工作区应用的源码修改）并建特性分支**

```bash
cd /home/ivhu/.config/piplus/projects/piplus
git switch -c feat/compile-binary
git add packages/db/src/init.ts
git commit -m "feat(db): findMigrationFile fallback to process.execPath for compiled binaries"
git switch dev
```

- [ ] **Step 2: 创建隔离 worktree 并安装依赖**

```bash
git worktree add .worktrees/compile-binary feat/compile-binary
cd .worktrees/compile-binary
bun install --frozen-lockfile
```

- [ ] **Step 3: 基线测试（确认干净起点）**

```bash
cd apps/api && bun test
cd ../.. && bun run typecheck
```

Expected: 全部通过（与主工作区基线一致）。若失败：停下报告，不继续。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: baseline" --allow-empty || true
```

---

### Task 2: apps/api/package.json 新增 build:compile

**Files:**
- Modify: `apps/api/package.json`

- [ ] **Step 1: 修改 scripts**

```json
"build:compile": "bun build --compile src/index.ts --outfile dist/piplus-api && cp ../../packages/db/migrations/0001_initial.sql ../../apps/migrations/0001_initial.sql",
"build:bundle": "bun build src/index.ts --target bun --outdir dist && cp ../../packages/db/migrations/0001_initial.sql ../../apps/migrations/0001_initial.sql",
```

（build:bundle 仅去掉 `&& bash ../../scripts/copy-pty-libs.sh`，保留调试用途；migrations 拷贝保留，与现状一致）

- [ ] **Step 2: 验证编译产物**

```bash
cd apps/api && bun run build:compile && ls -la dist/piplus-api && file dist/piplus-api
```

Expected: `dist/piplus-api` 存在，ELF 可执行文件。

- [ ] **Step 3: Commit**

```bash
git add apps/api/package.json && git commit -m "feat(api): add build:compile script (bun build --compile)"
```

---

### Task 3: 删除 copy-pty-libs.sh、gitignore bun-bin

**Files:**
- Delete: `scripts/copy-pty-libs.sh`
- Modify: `.gitignore`

- [ ] **Step 1: 删除脚本**

```bash
git rm scripts/copy-pty-libs.sh
```

- [ ] **Step 2: .gitignore 增加 bun-bin/（防陈旧目录被误跟踪）**

在 `.gitignore` 的 `pty-libs/` 行附近追加 `bun-bin/`。

- [ ] **Step 3: 确认无残留引用**

```bash
grep -rn "copy-pty-libs" --include="*.sh" --include="*.json" --include="*.yml" apps/ scripts/ packages/ || echo "no references"
```

Expected: no references（apps/api/package.json 的调用已在 Task 2 移除）。

- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore(scripts): remove copy-pty-libs.sh, ignore bun-bin/"
```

---

### Task 4: electron-builder.yml 移除 bun-bin/pty-libs/api-dist，新增 bin/

**Files:**
- Modify: `apps/desktop/electron-builder.yml`

- [ ] **Step 1: 修改 extraResources**

```yaml
extraResources:
  - from: assets
    to: assets
  - from: ../web/dist
    to: web-dist
  - from: ../migrations
    to: migrations
  - from: ../api/dist
    to: bin
    filter:
      - "piplus-api*"
```

要点：
- 删除 `pty-libs`、`bun-bin`、`../api/dist → api-dist` 三条
- 单条 `../api/dist → bin` + filter `piplus-api*`：linux/mac 命中 `piplus-api`，win 命中 `piplus-api.exe`，全平台通用，无平台级 extraResources 合并行为风险
- 保持 `from: ../migrations to: migrations`（二进制经 `dirname(execPath)/../migrations` 找到）

- [ ] **Step 2: 语法校验**

```bash
cd apps/desktop && bunx electron-builder --help >/dev/null 2>&1 && echo ok
```

（真正验证在 Task 10 打包后检查 resources/bin/）

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/electron-builder.yml && git commit -m "feat(desktop): package compiled api binary into resources/bin, drop bun-bin/pty-libs/api-dist"
```

---

### Task 5: resolve-paths.ts 新增 getApiCommand

**Files:**
- Modify: `apps/desktop/src/main/resolve-paths.ts`

- [ ] **Step 1: 重写文件核心逻辑**

替换 `prodApiDist()` 与 `getApiEntryPath()`，并简化 `resolveBunExecutable()`：

```ts
/** Compiled API binary name inside resources/bin/ (extraResources) */
function apiBinaryName(): string {
  return process.platform === 'win32' ? 'piplus-api.exe' : 'piplus-api';
}

/** Where the compiled API binary lives in production (extraResources → bin/) */
function prodApiBinaryPath(): string {
  return resolve(process.resourcesPath, 'bin', apiBinaryName());
}

/** Where the web build lives in production (extraResources) */
function prodWebDist() {
  return resolve(process.resourcesPath, 'web-dist');
}

// ---------------------------------------------------------------------------
// development paths (repo-relative from dist/main/)
// ---------------------------------------------------------------------------

export const repoRoot = resolve(__dirname, '../../../../');

// ---------------------------------------------------------------------------
// public helpers
// ---------------------------------------------------------------------------

/** TypeScript entrypoint used in development mode (spawned with bun). */
export function getApiEntryPath(): string {
  return resolve(repoRoot, 'apps/api/src/index.ts');
}

/**
 * Command used to launch the API.
 * - Packaged: the compiled single-file binary (bun build --compile), runs directly.
 * - Development: bun + TypeScript entrypoint.
 */
export function getApiCommand(): { command: string; args: string[] } {
  if (app.isPackaged) {
    return { command: prodApiBinaryPath(), args: [] };
  }
  return { command: resolveBunExecutable(), args: [getApiEntryPath()] };
}

export function getApiCwd(): string {
  return app.isPackaged ? resolve(process.resourcesPath, 'bin') : repoRoot;
}

export function getWebDistIndexPath(): string {
  return resolve(getWebProdDir(), 'index.html');
}

export function getWebProdDir(): string {
  return app.isPackaged
    ? prodWebDist()
    : resolve(repoRoot, 'apps/web/dist');
}

export function getPreloadPath(): string {
  return resolve(desktopDistRoot, 'preload/index.js');
}

/**
 * Resolve the Bun executable for development mode.
 *
 * Resolution order:
 * 1. `PIPLUS_BUN_PATH` environment variable (explicit override)
 * 2. `'bun'` (expect system PATH)
 */
export function resolveBunExecutable(): string {
  return process.env.PIPLUS_BUN_PATH ?? 'bun';
}
```

注意：删除 `prodApiDist()` 与 `existsSync` import（不再需要）。

- [ ] **Step 2: Commit**

```bash
git add apps/desktop/src/main/resolve-paths.ts && git commit -m "feat(desktop): run compiled api binary in packaged mode, bun only in dev"
```

---

### Task 6: api-process.ts 使用 getApiCommand

**Files:**
- Modify: `apps/desktop/src/main/api-process.ts`

- [ ] **Step 1: 修改 import 与 spawn 调用**

```ts
import { getApiCommand, getApiCwd, repoRoot } from './resolve-paths.js';
```

```ts
export function startApiProcess(options: ApiProcessOptions): ChildProcessWithoutNullStreams {
  const { command, args } = getApiCommand();
  console.log(`[desktop/api] Starting API: ${command}${args.length > 0 ? ` ${args.join(' ')}` : ''}`);
  const webDistDir = options.webDistDir ?? resolve(repoRoot, 'apps/web/dist');
  const apiLogPath = resolve(options.paths.logsDir, 'api.log');
  // ...（logStream 部分不变）...
  const child = spawn(command, args, {
    cwd: getApiCwd(),
    env: {
      // env 不变：无需 BUN_PTY_LIB（编译产物内嵌 pty 原生库）
      ...
    },
    stdio: 'pipe',
  });
  // ...（stdout/stderr/exit 处理不变）...
```

- [ ] **Step 2: typecheck**

```bash
cd apps/desktop && bun run typecheck
```

Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/main/api-process.ts && git commit -m "refactor(desktop): spawn api binary directly via getApiCommand"
```

---

### Task 7: scripts/build-desktop.sh 重写

**Files:**
- Modify: `scripts/build-desktop.sh`

- [ ] **Step 1: 重写（步骤 1/4/5 改，其余保留）**

结构变化：
- TARGET/ARCH 解析提前到步骤 1 之前（原本在步骤 3 后）
- 步骤 1 改为按 TARGET 交叉编译，且先 `rm -rf apps/api/dist`（清陈旧产物，保证 `filter: "piplus-api*"` 只命中本次产物）
- 删除原步骤 4（bun-bin）与步骤 5（pty-libs）
- 验证清单改为检查 `apps/api/dist/piplus-api[.exe]`
- 步骤编号改为 [1/4]–[4/4]

完整脚本（替换全文件）：

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo ""
echo "  ╔══════════════════════════════════════╗"
echo "  ║     piplus desktop build             ║"
echo "  ╚══════════════════════════════════════╝"
echo ""

VERSION=$(jq -r '.version' apps/desktop/package.json)
TARGET="${1:-linux}"
ARCH="${2:-}"

# ── 1. Compile API binary (bun build --compile) ───────────
echo "[1/4] Compiling API binary (target: $TARGET) ..."
cd apps/api
rm -rf dist
case "$TARGET" in
  win)
    bun build --compile src/index.ts --target=bun-windows-x64 --outfile dist/piplus-api.exe
    ;;
  mac)
    if [ "$ARCH" = "arm64" ]; then
      BUN_TARGET="bun-darwin-arm64"
    else
      BUN_TARGET="bun-darwin-x64"
    fi
    bun build --compile src/index.ts --target="$BUN_TARGET" --outfile dist/piplus-api
    ;;
  linux)
    # musl 构建提升跨发行版兼容性（避免 glibc 版本门槛）；
    # 若遇到 pty 原生库兼容问题，可退回 host 构建：bun build --compile src/index.ts --outfile dist/piplus-api
    bun build --compile src/index.ts --target=bun-linux-x64-musl --outfile dist/piplus-api
    ;;
  *)
    echo "Usage: $0 [linux|mac|win]"
    exit 1
    ;;
esac
cd "$OLDPWD"
API_BINARY="apps/api/dist/piplus-api"
[ "$TARGET" = "win" ] && API_BINARY="apps/api/dist/piplus-api.exe"
if [ ! -f "$API_BINARY" ]; then
  echo "  ❌ ERROR: API binary not found at $API_BINARY"
  echo "     Step 1 (API compile) may have silently failed."
  exit 1
fi
echo "  ✅ API binary verified: $API_BINARY"

# ── 2. Web build (desktop) ──────────────────────────────────
# Export version for Vite define injection
export APP_VERSION="$VERSION"
echo "[2/4] Building web for desktop ..."
cd apps/web
bun run build:desktop
cd "$OLDPWD"
if [ ! -f "apps/web/dist/index.html" ]; then
  echo "  ❌ ERROR: Web dist not found at apps/web/dist/index.html"
  echo "     Step 2 (Web build) may have silently failed."
  exit 1
fi
echo "  ✅ Web dist verified."

# ── 3. Desktop compile ──────────────────────────────────────
echo "[3/4] Building desktop main/preload ..."
cd apps/desktop
bun run build
cd "$OLDPWD"
if [ ! -f "apps/desktop/dist/main/index.js" ] || [ ! -f "apps/desktop/dist/preload/index.js" ]; then
  echo "  ❌ ERROR: Desktop dist not found at apps/desktop/dist/main/index.js or apps/desktop/dist/preload/index.js"
  echo "     Step 3 (Desktop compile) may have silently failed."
  exit 1
fi
echo "  ✅ Desktop dist verified."
echo "  → Version: $VERSION"

echo "  Verifying all extraResources sources before packaging..."
MISSING=""
[ -f "$API_BINARY" ] || MISSING="$MISSING  - $API_BINARY\n"
[ -f "apps/web/dist/index.html" ] || MISSING="$MISSING  - apps/web/dist/index.html\n"
[ -f "apps/desktop/dist/main/index.js" ] || MISSING="$MISSING  - apps/desktop/dist/main/index.js\n"
[ -f "apps/desktop/dist/preload/index.js" ] || MISSING="$MISSING  - apps/desktop/dist/preload/index.js\n"
[ -d "apps/migrations" ] || MISSING="$MISSING  - apps/migrations/\n"
[ -d "apps/desktop/assets" ] || MISSING="$MISSING  - apps/desktop/assets/\n"

if [ -n "$MISSING" ]; then
  echo "  ❌ ERROR: The following extraResources sources are missing:"
  printf "%b" "$MISSING"
  echo "     electron-builder will silently skip missing sources, producing an incomplete package."
  exit 1
fi
echo "  ✅ All extraResources sources verified."

# ── 4. Package ──────────────────────────────────────────────
echo "[4/4] Packaging${TARGET:+ for $TARGET} ..."
cd apps/desktop

# 清理上次产物
case "$TARGET" in
  linux) rm -rf dist/linux-unpacked dist/*.AppImage dist/*.deb dist/*.rpm ;;
  mac)   rm -rf dist/mac dist/*.dmg ;;
  win)   rm -rf dist/win-unpacked dist/*.exe ;;
esac

case "$TARGET" in
  linux)
    bunx electron-builder --linux
    echo ""
    echo "  ✅ AppImage: dist/piplus-${VERSION}-linux-amd64.AppImage"
    echo "  ✅ deb:      dist/piplus-${VERSION}-linux-amd64.deb"
    echo "  ✅ rpm:      dist/piplus-${VERSION}-linux-amd64.rpm"
    ;;
  mac)
    MAC_ARGS="--mac"
    if [ -n "$ARCH" ]; then
      MAC_ARGS="$MAC_ARGS --$ARCH"
    fi
    bunx electron-builder $MAC_ARGS
    # artifactName 模板用 ${arch} 输出 x64，改为 amd64
    if [ -f "dist/piplus-${VERSION}-mac-x64.dmg" ]; then
      mv "dist/piplus-${VERSION}-mac-x64.dmg" "dist/piplus-${VERSION}-mac-amd64.dmg"
    fi
    echo ""
    echo "  ✅ dmg: dist/piplus-${VERSION}-mac-${ARCH:-amd64}.dmg"
    ;;
  win)
    bunx electron-builder --win
    # artifactName 已处理命名，输出为 piplus-${VERSION}-win-amd64.exe
    echo ""
    echo "  ✅ exe: dist/piplus-${VERSION}-win-amd64.exe"
    ;;
  *)
    echo "Usage: $0 [linux|mac|win]"
    exit 1
    ;;
esac

echo ""
echo "  Done."
```

- [ ] **Step 2: 语法检查**

```bash
bash -n scripts/build-desktop.sh && echo "syntax ok"
```

- [ ] **Step 3: Commit**

```bash
git add scripts/build-desktop.sh && git commit -m "feat(scripts): compile api binary per-target, drop bun-bin/pty-libs steps"
```

---

### Task 8: README 文档更新

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 更新安装表格与打包说明**

- 安装表格 Linux 行「Bun（运行时需安装）」→「无（自包含二进制）」；前置要求第 1 条改为仅构建时需要 Bun
- 打包构建注释更新：

```text
bash scripts/build-desktop.sh linux   # AppImage + deb（API 编译为单文件二进制）
bash scripts/build-desktop.sh win     # Windows exe（交叉编译，无需本机 bun.exe）
bash scripts/build-desktop.sh mac     # macOS dmg
```

- [ ] **Step 2: 新增开发注意事项**（运行时读文件规则，放在「打包构建」小节末尾）

```markdown
> **开发注意：** API 打包为编译二进制后，`import.meta.dir` 是虚拟路径（`/$bunfs/root/...`）。
> 新增「运行时读磁盘文件」逻辑一律用 `process.execPath`（二进制路径）或 `__dirname` 推导，
> 不要用 `import.meta.dir`（参考 `packages/db/src/init.ts` 的 findMigrationFile）。
```

- [ ] **Step 3: Commit**

```bash
git add README.md && git commit -m "docs: update install/build docs for compiled api binary"
```

---

### Task 9: 全量类型检查与单元测试

**Files:** 无

- [ ] **Step 1: 全量 typecheck**

```bash
bun run typecheck
```

Expected: 全绿（web lint + api/desktop/db/domain/pi-client/shared typecheck）。

- [ ] **Step 2: API 单元测试**

```bash
cd apps/api && bun test
```

Expected: 全绿（无任何用例依赖 bun-bin/pty-libs/api-dist）。

- [ ] **Step 3: Commit（如有修复）**

---

### Task 10: 完整 Linux 构建（AppImage/deb/rpm）

**Files:** 无（构建验证）

- [ ] **Step 1: 运行完整构建**

```bash
bash scripts/build-desktop.sh linux
```

Expected: 产出 `apps/desktop/dist/piplus-*.AppImage`、`.deb`、`.rpm`，无 bun-bin/pty-libs 警告。

- [ ] **Step 2: 检查打包产物内容（linux-unpacked）**

```bash
cd apps/desktop/dist/linux-unpacked/resources
ls -la bin/            # 应只有 piplus-api，且 x 权限位存在
test -x bin/piplus-api && echo "exec ok"
ls migrations/         # SQL 文件齐全
ls web-dist/ | head -3
ls api-dist bun-bin pty-libs 2>&1  # 应全部不存在
file bin/piplus-api    # ELF
```

- [ ] **Step 3: Commit（如有脚本修复）**

---

### Task 11: 运行时验证（编译二进制 + musl 决策点）

**Files:** 无（验证脚本可放 /tmp，不入库）

- [ ] **Step 1: 隔离环境启动二进制**

```bash
rm -rf /tmp/piplus-compile-e2e && mkdir -p /tmp/piplus-compile-e2e/{data,projects,web}
cp apps/web/dist/* -r /tmp/piplus-compile-e2e/web/   # 或直接指向 apps/web/dist
cd /tmp/piplus-compile-e2e
API_PORT=18421 PIPLUS_DATA_DIR=/tmp/piplus-compile-e2e/data \
DATABASE_URL=file:/tmp/piplus-compile-e2e/data/test.sqlite \
PROJECTS_ROOT=/tmp/piplus-compile-e2e/projects \
PIPLUS_WEB_DIST=/home/ivhu/.config/piplus/projects/piplus/.worktrees/compile-binary/apps/web/dist \
PIPLUS_SERVE_WEB=1 \
<worktree>/apps/api/dist/piplus-api > /tmp/piplus-compile-e2e/api.log 2>&1 &
```

（用 apps/web/dist 绝对路径即可，无需拷贝；musl 二进制路径为 `<worktree>/apps/api/dist/piplus-api`）

- [ ] **Step 2: 健康检查 + web + packages**

```bash
curl -s -m 3 -o /dev/null -w "GET / -> %{http_code}\n" http://127.0.0.1:18421/
curl -s -m 3 -o /dev/null -w "GET /health -> %{http_code}\n" http://127.0.0.1:18421/health
curl -s -m 3 http://127.0.0.1:18421/ | grep -o "<title>[^<]*</title>"
curl -s -m 3 http://127.0.0.1:18421/api/v1/packages | head -c 400
```

Expected: `/` 200 + title、/health 200、packages 列出 4 个扩展（HOME=/home/ivhu 时读 ~/.pi/agent settings.json）。

- [ ] **Step 3: pty 终端验证（musl 决策点）**

参考 `apps/api/src/ws/server.ts` 的 ws 协议（hello → terminal_start → terminal_input → 观察输出）：通过 api 创建项目+会话（POST /api/v1/projects、POST /api/v1/sessions），再连 ws 发 `terminal_start`，写入 `echo pty-musl-ok\r`，断言回包含 `pty-musl-ok`。

**musl 决策：** 若 pty 通过 → 保留 musl（Task 7 现状）。若 pty 失败 → 改回 host target（`bun build --compile src/index.ts --outfile dist/piplus-api`）重编重测，并在 build-desktop.sh 注释中说明原因；本验证对 glibc 版本重复一次 pty 测试。

- [ ] **Step 4: 扩展加载验证（重点）**

用临时数据目录 + `HOME=/home/ivhu`（复用已配置的 4 个扩展，只读）：
- 复制 `~/.config/piplus/piplus-models.json` 到临时 data 目录（含用户 API key，仅测试用，不入库、不输出）
- 建会话、发一条极短消息（如 "hi"，费用约 0.001 元级，走用户 kkai provider）
- 断言：
  - api.log 无 `ResolveMessage`
  - api.log 出现扩展加载成功迹象（pi-superpowers 等扩展的注册/工具加载日志，或会话工具列表含扩展工具）
  - 对比基线：当前实时实例日志已有 2 条 ResolveMessage（`/home/ivhu/.config/piplus/logs/api.log`）

- [ ] **Step 5: 收尾**

```bash
kill %1 2>/dev/null; wait 2>/dev/null
```

---

### Task 12: AppImage 隔离冒烟测试

**Files:** 无

- [ ] **Step 1: 隔离启动 AppImage（不触碰实时实例）**

实时实例占用了 `~/.config/piplus` 与常用端口 —— 必须隔离：

```bash
mkdir -p /tmp/piplus-appimage-e2e
XDG_CONFIG_HOME=/tmp/piplus-appimage-e2e/config \
XDG_DATA_HOME=/tmp/piplus-appimage-e2e/data \
HOME=/tmp/piplus-appimage-e2e/home \
./apps/desktop/dist/piplus-*.AppImage > /tmp/piplus-appimage-e2e/desktop.log 2>&1 &
```

（若 FUSE 不可用则 `--appimage-extract-and-run`；桌面会短暂弹出窗口，可接受）

- [ ] **Step 2: 轮询 health（electron 日志里会有 api 端口，或 ps 找 api 进程）**

```bash
# 从 desktop.log / ps 找到 api 端口（getPreferredPort 默认端口，被占用则随机）
for i in $(seq 1 60); do curl -s -m 2 http://127.0.0.1:18555/health 2>/dev/null && break; sleep 1; done
```

Expected: health 200；`ps aux | grep piplus-api` 显示二进制路径为 `.../resources/bin/piplus-api`（非 bun + index.js）；`/tmp/piplus-appimage-e2e/config/logs/api.log` 无 ResolveMessage。

- [ ] **Step 3: pty 复测（AppImage 环境：squashfs 挂载 + 原生库）**

对 AppImage 实例重复 Task 11 Step 3 的 pty 流程（数据目录在隔离 HOME 下）。

- [ ] **Step 4: 关闭**

```bash
pkill -f "piplus-appimage-e2e" 2>/dev/null || pkill -f "piplus-0.*AppImage" ; sleep 2; pkill -9 -f "resources/bin/piplus-api" 2>/dev/null || true
```

（小心：不要 kill 到实时实例 —— 用隔离目录特征匹配）

---

### Task 13: win/mac 交叉编译冒烟

**Files:** 无

- [ ] **Step 1: 按 CI 方式跑编译步骤**

```bash
cd apps/api
rm -rf dist
bun build --compile src/index.ts --target=bun-windows-x64 --outfile dist/piplus-api.exe
file dist/piplus-api.exe    # PE32+
rm -rf dist
bun build --compile src/index.ts --target=bun-darwin-x64 --outfile dist/piplus-api
file dist/piplus-api        # Mach-O x86_64
rm -rf dist && bun build --compile src/index.ts --target=bun-darwin-arm64 --outfile dist/piplus-api && file dist/piplus-api  # Mach-O arm64
```

Expected: 三个目标产物格式正确（CI 下次打 tag 时做完整 electron-builder 验证）。

---

### Task 14: 审查循环与合并

- [ ] **Step 1: reviewer 审查全部 diff**
- [ ] **Step 2: 修复 reviewer 发现的问题（worker），通知 reviewer 复审，直至通过**
- [ ] **Step 3: 合并回 dev**

```bash
cd /home/ivhu/.config/piplus/projects/piplus
git merge --no-ff feat/compile-binary -m "feat: integrate bun build --compile packaging (drop bun-bin/pty-libs)"
git worktree remove .worktrees/compile-binary
```

- [ ] **Step 4: 向用户报告**

---

## Self-Review

**Spec coverage：**
- ✅ build:compile 脚本（Task 2）
- ✅ build-desktop.sh 步骤 1 改编译、步骤 4/5 删除（Task 7）
- ✅ electron-builder.yml bun-bin/pty-libs/api-dist 移除 + bin/ 新增（Task 4）
- ✅ resolve-paths.ts getApiEntryPath 改造（Task 5）
- ✅ api-process.ts 直接执行二进制、去掉 BUN_PTY_LIB 相关（Task 6）
- ✅ win/mac 同步改（Task 7/13）
- ✅ 验证：typecheck（Task 9）、完整构建（Task 10）、AppImage 启动+web+pty+扩展（Task 11/12）
- ✅ migrations 保留 extraResources、process.execPath 规则写入注释与文档（Task 8，init.ts 注释已在 Task 1 提交）
- ✅ 代码风格保持一致（沿用现有脚本/文件结构）

**占位符扫描：** 无 TBD/TODO；所有代码与命令完整。

**类型一致性：** `getApiCommand()` 返回 `{ command, args }`，Task 5 定义与 Task 6 使用一致；`apiBinaryName()`/`prodApiBinaryPath()` 内部一致；electron-builder filter `piplus-api*` 与产出名 `piplus-api`/`piplus-api.exe` 一致。
