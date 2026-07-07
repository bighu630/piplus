<div align="center">
  <br/>
  <h1>🪐 Piplus</h1>
  <p><strong>Pi Coding Agent 本地桌面工作台</strong></p>
  <p>
    用更顺手的方式管理项目、Session、模型、文件、Git 和多角色协作
  </p>
  <br/>
  <img src="https://origin.picgo.net/2026/06/24/image7d37588b7f087d4b.png" alt="Piplus Screenshot" width="800" style="border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.12)"/>
  <br/><br/>
</div>

---

## 📦 安装

<table>
<tr>
<th>平台</th><th>格式</th><th>系统依赖</th>
</tr>
<tr>
<td>🐧 Linux</td><td>AppImage / deb</td><td><a href="https://bun.sh">Bun</a>（运行时需安装）</td>
</tr>
<tr>
<td>🍎 macOS</td><td>dmg</td><td>安装后需执行 <code>xattr -c /Applications/piplus.app</code></td>
</tr>
<tr>
<td>🪟 Windows</td><td><code>piplus Setup *.exe</code></td><td>无额外依赖</td>
</tr>
</table>

### 前置要求

1. 安装 **Bun**（Linux 必需 / Windows 免装）：<https://bun.sh>

---

## 🚀 快速启动

下载对应平台的最新包，从 [Releases](https://github.com/bighu630/piplus/releases) 获取。

**Linux：**
```bash
chmod +x piplus-*.AppImage
./piplus-*.AppImage
# 或
sudo dpkg -i piplus_*.deb
```

**Windows：** 直接运行安装程序，安装完成后从桌面 / 开始菜单启动。

---

## 🤖 多角色协作

Piplus 内置角色化工作方式，让复杂的开发任务管理更自然：

| 角色 | 职责 |
|------|------|
| **planner** | 负责人 / 规划者，拆解大目标 |
| **worker** | 执行者，完成具体任务 |
| **reviewer** | 代码审查 |
| **feat_lead** | 功能需求负责人 |
| **bugfix_lead** | Bug 修复负责人 |
| **blank** | 通用助手 |

典型流程：`planner 拆解 → feat_lead 对齐 → worker 执行 → reviewer 审查`

> eg: 对 planner 说"帮我把这个项目的前后端打包成docker"，较大的需求 planner 会自动创建 feat_lead 去对齐细节并实现。

---

## 🧭 核心页面

<table>
<tr>
<td width="50%"><strong>项目 / Session 树</strong><br/><img src="https://free.boltp.com/2026/06/24/6a3b6e49be599.webp" width="100%"/></td>
<td width="50%"><strong>Chat</strong><br/><img src="https://origin.picgo.net/2026/06/24/image2d0a3c01385d8db4.png" width="100%"/></td>
</tr>
<tr>
<td><strong>Files</strong><br/><img src="https://origin.picgo.net/2026/06/24/image8d44e66bc3bf1a99.png" width="100%"/></td>
<td><strong>Git / Session Info / 更多…</strong><br/><br/>
<ul>
<li>查看 diff、Pull、Push、Commit</li>
<li>Session 上下文：ID / 模型 / 角色模板 / 提示词 / 运行状态</li>
<li>排查角色系统、模型继承和工具调用链</li>
</ul>
</td>
</tr>
</table>

---

## 🧬 模型继承逻辑

Piplus 不使用简单的"统一默认模型"，而是贴近实际工作的继承规则：

- **创建项目时** → 为负责人 Session 指定模型
- **手动新建顶层 Session** → 继承负责人模型
- **角色系统创建子 Session** → 继承父 Session 模型

这样你可以精确控制：哪个项目用什么模型、哪条任务链用什么模型。

---

## 🔒 本地优先

数据存放在本地，无需远程后端：

```text
~/.config/piplus/
  └── piplus.sqlite    # 主数据库
```

Pi 自己的 agent / session 数据仍由 Pi 自己管理（~/.pi/agent/）。

---

## 🛠 开发

```bash
bun install          # 安装依赖
bun run dev          # 启动 API + Web 开发模式
bun run dev:api      # 仅 API
bun run dev:web      # 仅 Web
bun run dev:desktop  # 桌面开发模式
bun run typecheck    # 全量类型检查
bun run test         # API 测试
```

**日志排障：** 开发日志 → `/tmp/piplus-logs/`（可覆盖 `PIPLUS_LOG_DIR`）<br/>
**桌面日志：** Electron 应用目录下 `logs/`

### 打包构建

```bash
bash scripts/build-desktop.sh linux   # AppImage + deb
bash scripts/build-desktop.sh win     # Windows exe（自动打包 bun）
bash scripts/build-desktop.sh mac     # macOS dmg
```

---

## 📁 项目结构

```text
apps/
  api/        # 本地 API（Bun）
  web/        # Web 前端（React + Vite）
  desktop/    # Electron 桌面壳
packages/
  db/         # SQLite / schema / 迁移
  domain/     # 领域逻辑（session、角色系统等）
  pi-client/  # Pi SDK 适配层
  shared/     # 前后端共享 DTO / 类型
```

---

<div align="center">
  <sub>Built for <a href="https://pi.dev">Pi Coding Agent</a> · 本地优先 · 多角色协作 · 畅快开发</sub>
</div>
