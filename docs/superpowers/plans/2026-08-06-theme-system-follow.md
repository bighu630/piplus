# 主题跟随系统（三态）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将主题从两态（light/dark）扩展为三态（light/dark/system），Web 端 + Electron 桌面端均支持跟随系统，并加入 FOUC 防闪烁。

**Architecture:** 渲染进程统一使用三态偏好（localStorage key `pi-workspace-theme`，新增值 `'system'`，默认 `'system'`），通过 matchMedia 监听 `prefers-color-scheme` 解析出"生效主题"（resolvedTheme）。dark class 统一从 App 根 div 移到 `document.documentElement`，FOUC 内联脚本在首帧前设置它。桌面端主进程通过自建 JSON 存储 + IPC 同步把偏好映射为 `nativeTheme.themeSource`（渲染进程 localStorage 是权威源，主进程存储仅用于窗口创建前启动即正确）。

**Tech Stack:** React 18 + Tailwind v4（`@variant dark`）、Electron 42（nativeTheme）、Vite、TypeScript、highlight.js、xterm.js。

**已确认决策（用户拍板）：** 默认值 `'system'`；旧值 `'light'`/`'dark'` 兼容；非法值回退默认。

**两端接口契约（Lead 已先提交 `runtime-config.ts` 类型扩展）：**
- localStorage key 不变：`pi-workspace-theme`
- 偏好值域：`'light' | 'dark' | 'system'`，默认 `'system'`
- IPC channel：`theme:set-preference`（渲染 → 主，`ipcRenderer.send`）
- preload 暴露：`window.piplusConfig.theme.setPreference(preference: 'light' | 'dark' | 'system')`
- 主进程持久化文件：`<userData>/theme.json`，格式 `{"preference": "light"|"dark"|"system"}`
- dark class 位置：`document.documentElement`（html 元素），Tailwind variant `&:where(.dark, .dark *)` 对 html 上的 class 同样生效
- 生效主题（resolvedTheme）：`pref === 'system' ? (systemDark ? 'dark' : 'light') : pref`

---

## Task 1: 新增 Web 端主题核心模块 `lib/theme.ts`

**Files:**
- Create: `apps/web/src/lib/theme.ts`

- [ ] **Step 1: 创建 `apps/web/src/lib/theme.ts`**

```ts
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'pi-workspace-theme';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(saved)) return saved;
  } catch {
    // localStorage unavailable (private mode / disabled)
  }
  return DEFAULT_THEME_PREFERENCE;
}

export function prefersDarkScheme(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function applyThemeClass(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
```

- [ ] **Step 2: 运行 typecheck**

Run: `cd apps/web && bun run lint`
Expected: PASS（无错误）

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/lib/theme.ts
git commit -m "feat(web): add three-state theme core module"
```

---

## Task 2: App.tsx 主题状态三态化

**Files:**
- Modify: `apps/web/src/App.tsx:197-236`（theme state 初始化、持久化 effect）

- [ ] **Step 1: 修改 theme state 为三态**

将现有（约行 199-207）：

```tsx
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('pi-workspace-theme');
      return saved === 'dark' ? 'dark' : 'light';
    } catch {
      return 'light';
    }
  });
```

替换为：

```tsx
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDarkScheme());
```

并在文件顶部 import 区加入：

```tsx
import {
  THEME_STORAGE_KEY,
  applyThemeClass,
  prefersDarkScheme,
  readThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './lib/theme';
```

- [ ] **Step 2: 替换持久化 effect 并新增派生逻辑**

将现有（约行 225-234）：

```tsx
  useEffect(() => {
    try { localStorage.setItem('pi-workspace-theme', theme); } catch {}
    const hljsLinkId = 'hljs-theme';
    const existing = document.getElementById(hljsLinkId);
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.id = hljsLinkId;
    link.rel = 'stylesheet';
    link.href = theme === 'dark' ? hljsDark : hljsLight;
    document.head.appendChild(link);
  }, [theme]);
```

替换为：

```tsx
  // 解析生效主题：system 偏好由 matchMedia 解析，绝不写回用户偏好
  const resolvedTheme: ResolvedTheme = resolveTheme(theme, systemDark);

  // 仅 system 模式监听系统主题变化
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  // 持久化用户偏好（偏好本身，非解析值）
  useEffect(() => {
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch {}
  }, [theme]);

  // dark class 应用到 documentElement（React 挂载后接管 FOUC 脚本设置）
  useEffect(() => {
    applyThemeClass(resolvedTheme);
  }, [resolvedTheme]);

  // highlight.js 样式跟随生效主题
  useEffect(() => {
    const hljsLinkId = 'hljs-theme';
    const existing = document.getElementById(hljsLinkId);
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.id = hljsLinkId;
    link.rel = 'stylesheet';
    link.href = resolvedTheme === 'dark' ? hljsDark : hljsLight;
    document.head.appendChild(link);
  }, [resolvedTheme]);

  // 桌面端：偏好变化时同步主进程 nativeTheme.themeSource
  useEffect(() => {
    window.piplusConfig?.theme?.setPreference?.(theme);
  }, [theme]);
```

- [ ] **Step 3: 修改根 div 的 class**

将（约行 648）：

```tsx
    <div className={`flex flex-col md:flex-row h-[100dvh] min-h-0 w-full overflow-hidden overscroll-none bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased ${theme}`}>
```

替换为（去掉 `${theme}` 拼接，dark class 现在在 html 上）：

```tsx
    <div className="flex flex-col md:flex-row h-[100dvh] min-h-0 w-full overflow-hidden overscroll-none bg-slate-100 dark:bg-slate-950 text-slate-800 dark:text-slate-100 font-sans antialiased">
```

- [ ] **Step 4: 子组件传参分工（reviewer 修正：原稿 875/914 均改 resolvedTheme 有误）**

只改 TabTerminal 处（原行 875）的 `theme={theme}` 为 `theme={resolvedTheme}`（TabTerminal 的 props 类型是 `'light' | 'dark'`，resolvedTheme 类型兼容，组件本身无需改动，xterm 主题自动跟随生效主题）。

SettingsPanel 处（原行 914）**保留**传偏好 `theme={theme}`：SettingsPanel 的按钮高亮需要知道用户偏好（`theme === 'system'` 时"跟随系统"按钮必须高亮），传 resolvedTheme 会导致 system 模式下跟随系统按钮永不高亮。

- [ ] **Step 5: 运行 typecheck**

Run: `cd apps/web && bun run lint`
Expected: PASS

- [ ] **Step 6: 运行 web 测试**

Run: `cd apps/web && bun test`
Expected: PASS（App.test.ts hook 顺序测试不受影响——注意新加的 useState/useEffect 都必须在 `isLoggedIn` guard 之前，与现有代码位置一致）

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): three-state theme with system preference in App"
```

---

## Task 3: SettingsPanel 三按钮 UI

**Files:**
- Modify: `apps/web/src/components/SettingsPanel.tsx:19-20`（props 类型）、`101-110`（主题按钮区）

- [ ] **Step 1: 修改 props 类型**

将：

```tsx
  theme: 'light' | 'dark';
  onThemeChange: (theme: 'light' | 'dark') => void;
```

替换为：

```tsx
  theme: 'light' | 'dark' | 'system';
  onThemeChange: (theme: 'light' | 'dark' | 'system') => void;
```

- [ ] **Step 2: 替换主题按钮区为三按钮**

将（约行 101-110）"主题" 区块中的两个按钮替换为三个按钮（使用 lucide-react 图标 Sun/Monitor/Moon，lucide-react 已在依赖中）：

```tsx
            <div className="flex-1 min-w-[240px]">
              <label className="block text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-2">主题</label>
              <div className="flex gap-2">
                <button onClick={() => onThemeChange('light')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${theme === 'light' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}><Sun size={14} />浅色</button>
                <button onClick={() => onThemeChange('system')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${theme === 'system' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}><Monitor size={14} />跟随系统</button>
                <button onClick={() => onThemeChange('dark')} className={`flex-1 px-3 py-2 text-xs font-semibold rounded-lg border transition cursor-pointer inline-flex items-center justify-center gap-1.5 ${theme === 'dark' ? 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800 text-blue-700 dark:text-blue-400' : 'bg-slate-50 dark:bg-slate-800 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400'}`}><Moon size={14} />深色</button>
              </div>
            </div>
```

（注意：原区块外层是 `min-w-[200px]` 的 flex-1 容器，三按钮放得下则保留原宽度；若视觉拥挤可改为 `min-w-[240px]`，与发送快捷键区块一致。）

- [ ] **Step 3: 修改 import**

将顶部：

```tsx
import { Settings, RefreshCw, Trash2 } from 'lucide-react';
```

替换为：

```tsx
import { Settings, RefreshCw, Trash2, Sun, Monitor, Moon } from 'lucide-react';
```

- [ ] **Step 4: 运行 typecheck + 测试**

Run: `cd apps/web && bun run lint && bun test`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web/src/components/SettingsPanel.tsx
git commit -m "feat(web): three-button theme picker in settings"
```

---

## Task 4: FOUC 防闪烁内联脚本

**Files:**
- Modify: `apps/web/index.html`（head 内、`<link rel="manifest">` 之前插入）

- [ ] **Step 1: 在 `<head>` 中插入内联阻塞脚本**

在 `<meta name="theme-color" ...>` 之前插入（必须保持默认值 `'system'` 与 `lib/theme.ts` 的 `DEFAULT_THEME_PREFERENCE` 一致）：

```html
    <script>
      (function () {
        try {
          var t = localStorage.getItem('pi-workspace-theme');
          if (t !== 'light' && t !== 'dark' && t !== 'system') t = 'system';
          var dark = t === 'dark' || (t === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
          if (dark) document.documentElement.classList.add('dark');
        } catch (e) {}
      })();
    </script>
```

- [ ] **Step 2: 验证**

Run: `cd apps/web && bun run lint` 确认构建无碍；`bun run build` 确认产物包含脚本且 `dark` class 在 body 解析前设置（可检查 `dist/index.html`）。

- [ ] **Step 3: 提交**

```bash
git add apps/web/index.html
git commit -m "feat(web): FOUC-prevention inline theme script"
```

---

## Task 5: 桌面端主进程 nativeTheme + 持久化

**Files:**
- Create: `apps/desktop/src/main/theme.ts`
- Modify: `apps/desktop/src/main/index.ts`（bootstrap 中调用 initTheme）

- [ ] **Step 1: 创建 `apps/desktop/src/main/theme.ts`**

```ts
import { app, ipcMain, nativeTheme } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const THEME_PREFS = ['light', 'dark', 'system'] as const;
type ThemePreference = (typeof THEME_PREFS)[number];

const DEFAULT_PREFERENCE: ThemePreference = 'system';

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFS as readonly string[]).includes(value);
}

function getThemeFilePath(): string {
  return join(app.getPath('userData'), 'theme.json');
}

async function readStoredPreference(): Promise<ThemePreference> {
  try {
    const raw = await readFile(getThemeFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && isThemePreference((parsed as { preference?: unknown }).preference)) {
      return (parsed as { preference: ThemePreference }).preference;
    }
  } catch {
    // file missing or malformed → default
  }
  return DEFAULT_PREFERENCE;
}

function persistPreference(preference: ThemePreference): void {
  writeFile(getThemeFilePath(), JSON.stringify({ preference }), 'utf-8').catch(() => {
    // best-effort persistence
  });
}

export async function initTheme(): Promise<void> {
  const preference = await readStoredPreference();
  nativeTheme.themeSource = preference;

  ipcMain.on('theme:set-preference', (_event, preference: unknown) => {
    if (!isThemePreference(preference)) return;
    nativeTheme.themeSource = preference;
    persistPreference(preference);
  });
}
```

- [ ] **Step 2: 在 index.ts bootstrap 中接入**

在 `apps/desktop/src/main/index.ts` 顶部 import 区加入：

```ts
import { initTheme } from './theme.js';
```

在 `bootstrap()` 中、`createMainWindow` 调用之前加入（约在 `mainWindow = await createMainWindow(...)` 之前）：

```ts
  // Apply persisted theme preference before the window loads so the
  // renderer's prefers-color-scheme matches from the very first frame.
  await initTheme();
```

- [ ] **Step 3: typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add apps/desktop/src/main/theme.ts apps/desktop/src/main/index.ts
git commit -m "feat(desktop): map theme preference to nativeTheme.themeSource"
```

---

## Task 6: preload 暴露主题 API

**Files:**
- Modify: `apps/desktop/src/preload/index.ts`

- [ ] **Step 1: 扩展 preload**

将现有内容：

```ts
import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('piplusConfig', {
  isDesktop: true,
  platform: process.platform,
});
```

替换为：

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('piplusConfig', {
  isDesktop: true,
  platform: process.platform,
  theme: {
    setPreference: (preference: 'light' | 'dark' | 'system') => {
      ipcRenderer.send('theme:set-preference', preference);
    },
  },
});
```

- [ ] **Step 2: typecheck**

Run: `cd apps/desktop && bun run typecheck`
Expected: PASS（sandbox: true 下 preload 的 ipcRenderer.send 可用）

- [ ] **Step 3: 提交**

```bash
git add apps/desktop/src/preload/index.ts
git commit -m "feat(desktop): expose theme preference API via preload"
```

---

## Task 7: 全量验证

- [ ] **Step 1: 全量 typecheck**

Run: `bun run typecheck`（根目录，覆盖 api/web/desktop/db/domain/pi-client/shared）
Expected: 全部 PASS

- [ ] **Step 2: 测试**

Run: `bun run test`（api 测试）+ `cd apps/web && bun test`（web 测试）
Expected: 全部 PASS

- [ ] **Step 3: 手动验证 Web 端**

Run: `bun run dev:web`
验证清单：
1. 设置面板出现三个按钮：☀️ 浅色 / 🖥 跟随系统 / 🌙 深色
2. 默认（清 localStorage 后）为"跟随系统"选中态；系统浅色 → 页面浅色；系统深色 → 页面深色
3. 切换系统主题（OS 设置），system 模式下页面实时跟随；light/dark 模式下系统切换不影响页面
4. 手动选"浅色"→ 立即变浅色并持久化；刷新后保持浅色且不闪烁
5. 手动选"深色"→ 立即变深色；刷新时首帧即为深色（FOUC 生效，无浅色闪烁）
6. 代码块高亮样式（hljs）跟随生效主题
7. localStorage 中 `pi-workspace-theme` 值在 light/dark/system 间正确切换，且 system 模式下 OS 切换不会污染该值（保持 'system'）

- [ ] **Step 4: 手动验证桌面端**（如环境可行）

Run: `bun run dev:desktop`（或 `bun run build:desktop` 后运行打包产物）
验证清单：
1. 窗口启动即应用持久化偏好（首次默认跟随系统）
2. 设置面板切换三态 → 窗口实时变化
3. system 模式下切换 OS 主题 → 窗口实时跟随（nativeTheme.themeSource 驱动 matchMedia）
4. 重启应用后偏好保持
5. `<userData>/theme.json` 内容为 `{"preference":"light"|"dark"|"system"}`

---

## Self-Review 对照

| 需求 | 任务 |
|---|---|
| 三态存储 light/dark/system，默认 system，旧值兼容 | Task 1, 2 |
| 偏好与生效主题分离，不写回 | Task 2（持久化 effect 只存 theme 偏好） |
| matchMedia 监听仅 system 模式 | Task 2 |
| hljs link 跟随生效主题 | Task 2 |
| 根 div class 基于生效主题 | Task 2（移到 html，div 不再拼 class） |
| 设置面板三按钮 | Task 3 |
| FOUC 内联脚本 | Task 4 |
| MermaidBlock 检测修正 | 无需改：class 移到 html 后 `document.documentElement.classList.contains('dark')` 自动变有效 |
| TabTerminal xterm 跟随 | Task 2 Step 4（传 resolvedTheme，组件零改动） |
| 桌面端 nativeTheme.themeSource | Task 5 |
| 主进程持久化（读不到渲染 localStorage → 自建 JSON） | Task 5 |
| preload 主题 API | Task 6 |
| 验证 typecheck/test/手动 | Task 7 |
