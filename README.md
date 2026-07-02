# Piplus

> 给 **Pi Coding Agent** 准备的本地桌面工作台。
> 用更顺手的方式管理项目、Session、模型、文件、Git 和多角色协作。

![image](https://origin.picgo.net/2026/06/24/image7d37588b7f087d4b.png)


---

## 快速开始

### 安装依赖

先安装下面两个基础依赖：

- **Bun**：<https://bun.sh/>
- **Pi Coding Agent**：<https://pi.dev>

安装完成后，请确保 Pi 已经配置好至少一个可用模型。

---

### 启动应用

Piplus 提供 **本地桌面版（Electron）**。
Windows 和 Linux 都可以直接本地运行，不依赖远程服务器。

#### Linux

支持：

- `AppImage`
- `deb`

例如：

```bash
chmod +x piplus-*.AppImage
./piplus-*.AppImage
```

#### Windows

直接运行：

- `piplus Setup *.exe`

安装完成后，从桌面或开始菜单启动即可。

---

### 多角色协作更自然

Piplus 内置了一套角色化工作方式：

- **planner**：负责人 / 规划者
- **worker**：执行者
- **reviewer**: 代码review
- **feat_lead**：某需求的负责人
- **bugfix_lead**：某bug的负责人
- **blank**：通用助手

典型流程：

1. 负责人理解目标
2. 负责人拆解任务
3. 派生子 Session 执行

相比单一长对话，这种方式更适合实际开发工作。

eg: 和planner说： ”我有一个需求，帮我把这个项目的前后端打包成docker“ 通常而言，大一点的需用planner会自动创建feat_lead去对齐细节并实现

---

## 核心页面

### 项目 / Session 树
![session tree](https://free.boltp.com/2026/06/24/6a3b6e49be599.webp)

---

### Chat

![image](https://origin.picgo.net/2026/06/24/image2d0a3c01385d8db4.png)


---

### Files

![image](https://origin.picgo.net/2026/06/24/image8d44e66bc3bf1a99.png)

---

### Git

Git 页面聚焦在当前项目的本地 Git 工作流。

支持：

- 查看 diff
- Pull
- Push
- Commit

这样你可以在当前工作台里直接完成最常见的改动确认与提交动作。

---

### Session Info

Session Info 页面用于查看当前 Session 的完整上下文信息。

包括：

- Session ID
- 父 / 根 Session
- 当前模型
- 角色模板
- 提示词信息
- 最近事件
- 运行状态

它很适合在排查角色系统、模型继承和工具调用链时使用。

---

## 模型继承逻辑

Piplus 不是简单地“给所有 Session 一个默认模型”。

它使用一套更符合实际工作的模型继承规则：

- **创建项目时**：为负责人 Session 指定模型
- **手动新建顶层 Session**：继承负责人模型
- **角色系统创建子 Session**：继承父 Session 模型

这样你能更清楚地控制：

- 哪个项目用什么模型
- 哪条任务链用什么模型
- 不同 Session 之间为什么会继承当前模型

---

## 本地优先

Piplus 是一个本地优先工具。

应用数据默认放在：

```bash
~/.config/piplus/
```

当前主要包括：

- `piplus.sqlite`：主数据库

Pi 自己的 agent / session 数据仍由 Pi 自己管理（通常在 `~/.pi/agent/`）。

这意味着：

- 你的工作台数据在本机
- 你的项目上下文在本机
- 不需要额外部署远程后端才能使用

---

## 适合谁

Piplus 比较适合这些用户：

- 已经在用 Pi，希望有更完整的图形工作台
- 同时维护多个项目和多个 Session
- 需要管理负责人 / worker / reviewer 协作流程
- 希望把对话、文件、Git 和状态都放进同一个界面

---

## Docker 部署

如需使用单容器 Docker 部署方案，请参考 `deployment/docker/README.md`。

## 开发模式（可选）

如果你希望本地开发：

```bash
bun install
bun run dev
```

默认会启动：

- API：`http://localhost:3001`
- Web：`http://localhost:3002`

> **日志排障**：开发模式下输出同时写入终端和日志文件。
> - Dev 日志：`/tmp/piplus-logs/`（可覆盖 `PIPLUS_LOG_DIR` 环境变量）
> - Desktop 日志：Electron 应用目录下 `logs/` 子目录

---

## 常用脚本

```bash
# Web + API 开发
bun run dev

# 单独启动 API
bun run dev:api

# 单独启动 Web
bun run dev:web

# 桌面开发模式
bun run dev:desktop

# 全量类型检查
bun run typecheck

# API 测试
bun run test

# 桌面打包
bun run build:desktop -- linux
bun run build:desktop -- win
```

---

## 项目结构

```text
apps/
  api/        # 本地 API
  web/        # Web 前端
  desktop/    # Electron 桌面壳
packages/
  db/         # sqlite / schema / init
  domain/     # 领域逻辑（session、角色系统等）
  pi-client/  # Pi SDK 适配层
  shared/     # 前后端共享 DTO / 类型
```
