# AI Agent Platform 设计文档

## 1. 范围与产品目标

本文档固化了 v1 版本的设计结论：这是一个面向局域网优先、基于浏览器、按角色驱动的 AI agent 平台，使用单一 TypeScript 代码库实现。产品交互心智参考 Codex Desktop，但交付形态是网页工作台，而不是桌面壳应用。

v1 的核心目标是提供一个可用的项目 / session 工作台，包含：
- 本地账户登录
- 项目容器管理
- 基于 PI session 的父子 session 树
- 以对话为中心的 chat 主界面
- 只读的 Session Info 详情视图
- 轻量但可靠的本地控制面数据模型
- 基于 PI Agent SDK 之上，由平台自己实现的 session 派生与显式父节点写回能力

本文档在 API 设计和实现开始之前，先把架构、前端结构、后端模块边界、运行时行为和数据模型固定下来。

## 2. 产品约束与核心假设

### 2.1 部署与使用模式
- 产品是一个局域网优先的 Web 应用。
- 主要目标使用场景是桌面浏览器。
- 需要支持手机网页，但手机端是“导航优先”的适配形态，不是桌面多栏布局的缩小版。
- 系统支持本地账户登录和轻量多人使用。
- v1 不包含团队、组织、协作者以及高级 RBAC。
- 架构必须同时支持前后端分开部署和前后端一体部署。
- 分开部署时，前端和后端作为两个独立应用 / 服务运行。
- 一体部署时，前端和后端仍保持逻辑独立，只是在同一主机或同一反向代理下以单域名方式对外提供服务。

### 2.2 与 PI Agent SDK 的关系
- PI Agent SDK 被视为单 session 执行引擎。
- PI Agent SDK 是实时聊天历史和实时运行行为的真源。
- PI Agent SDK 不提供原生子 agent 编排能力，也不提供本文所说的角色系统。
- 子 session、角色模板、prompt 拼装、写回语义以及 session 树管理，都是平台自己实现的能力，不由 PI 提供。
- 本地数据库保存持久化的控制面模型和完整的消息 / 事件副本，但前端聊天主界面读取的是 PI，而不是本地消息副本。

### 2.3 v1 范围纪律
- Project 只是容器，不存在根 chat。
- 每个 session 与一个 PI agent session 1:1 对应。
- 每个 session 只绑定一个不可变的 role template。
- fork 语义由子 session 创建表达，而不是一个 session 内部的 thread 分叉。
- Session Info 是纯只读页面，不包含管理操作。
- tool 权限控制和按 role 限制 tool 的能力不进入 v1。
- 附件、文件上传和文件对象建模不进入 v1。
- 高级自动编排、run/job 细分以及自动多阶段写回策略不进入 v1。

## 3. 前端体验设计

### 3.1 总体壳层模型
桌面端前端是一个统一工作台壳，包含两个主要区域：
- 左侧：项目 / session 树
- 右侧：当前 session 主面板

右侧主面板右上角有两个 tabs：
- Chat
- Session Info

这两个 tab 是同一个 session 上下文下的两个视图，不是两个割裂页面。

#### 3.1.1 桌面端布局
- 左侧树可独立折叠。
- 左侧树在切换 session 时保持存在。
- 右侧进入 session 后默认展示 Chat。
- 只有选中 Session Info tab 时才展示 Session Info。
- 右侧整体是“对话优先”的，视觉上必须把消息历史和输入区放在主位，而不是让次级状态面板挤占空间。

#### 3.1.2 手机端布局
- 手机端不使用左右分栏。
- 项目 / session 树作为全屏导航页呈现。
- 选择项目或 session 后进入内容页。
- 在 session 内容页内，仍然通过顶部 tabs 切换 Chat 和 Session Info。
- 手机端明确采用“导航页 -> 内容页”的体验，而不是桌面布局的压缩版。

### 3.2 左侧树模型
左侧树是一个带有明确展开 / 收起行为、风格接近文件树的导航结构。

树结构层级为：
- Project
- Project 下的一级 Session
- Session 下的子 Session

重要语义：
- 这棵树反映的是平台维护的真实 session 派生关系，而不是纯 UI 分组。
- 父子关系对应 session 的派生 / spawn 关系。
- 每个 session 节点都要展示角色信息。
- 节点上需要体现运行状态和归档状态。

#### 3.2.1 节点交互
- 点击节点：选中并在右侧打开该 session。
- 点击展开箭头：只负责展开 / 收起。
- 点击节点本身不会隐式展开 / 收起其子节点。

#### 3.2.2 树中的归档展示
- 归档 session 保持在原有树结构位置中。
- 归档 session 默认隐藏。
- 左侧树提供一个切换按钮，用来显示已归档 session。
- 打开切换后，归档 session 在原位置显示，不会被挪到单独的归档区域。

#### 3.2.3 树排序规则
- Project 按最近活跃排序。
- Session 按最近活跃排序。
- Child Session 也按最近活跃排序。
- 同级节点统一按 `last_activity_at` 倒序排列。

### 3.3 Chat 页面行为
Chat 是任何被选中 session 的默认主视图。

#### 3.3.1 数据来源
- Chat 历史直接从 PI Agent SDK 读取，而不是从本地消息副本读取。
- 首次进入 Chat 时先加载最近一段消息。
- 更早历史通过向上滚动分页加载。
- 本地 `messages` 表仍然存在，但它的职责是副本 / 控制面，不是 chat 页面的主渲染源。

#### 3.3.2 消息语义
前端可见消息角色：
- `user`：用户发给当前 session 的消息
- `assistant`：当前 session 的正常回复，也包括子 session 写回到父 session 的消息
- `system`：极少量平台可见提示；v1 中应当很少出现

写回消息展示规则：
- 子 session 写回父 session 时，在父 chat 中表现为一条 assistant 消息。
- 这条消息带有明确来源标识，让用户知道它来自某个子 session。
- 数据上通过 `message_kind` 和 `source_session_id` 区分。

#### 3.3.3 发送与停止规则
- 同一个 session 不允许并发发送多条用户消息。
- session 运行中时，不允许再发送新消息。
- 停止一个运行中的 session 需要按两次 Esc。
- 第一次 Esc 进入“准备停止”的 UI 状态。
- 第二次 Esc 会真正向底层 PI agent 执行发送停止请求。
- 停止完成后，session 才会回到可继续发送新消息的空闲状态。
- 用户可以离开一个运行中的 session，切到别的 session；原 session 可以在后台继续运行。

### 3.4 Session Info 页面行为
Session Info 是当前 session 的只读解释视图。

#### 3.4.1 数据加载
- 打开 Chat 时默认不加载 Session Info 数据。
- 只有选中 Session Info tab 时才请求其数据。
- Session Info 读取的是本地平台数据库，而不是 PI 的实时聊天接口。

#### 3.4.2 信息密度
Session Info 是一个中等密度的信息页，不是日志终端，也不是重型运维台。

推荐分为四个区块：
1. Overview
2. Prompts
3. Sync
4. Recent Events

#### 3.4.3 Session Info 内容
Overview 需要包含：
- session title
- role template 的 name / key / version
- 所属 project
- parent session 与 root session 信息
- created_by 与 created_at
- `pi_session_id`
- 归档状态与运行状态

Prompts 需要包含：
- `role_base_prompt_snapshot`
- `user_supplied_prompt`
- `parent_supplied_prompt`
- `compiled_prompt`

Prompt 可见性规则：
- 这几段 prompt 全部可见
- `compiled_prompt` 可以默认折叠，避免页面过长

Sync 需要包含：
- `sync_status`
- `last_synced_at`
- `last_pi_message_id`
- `last_error`
- `retry_count`

Recent Events 需要包含：
- 最近一小段 `session_events`，例如最近 10-20 条

#### 3.4.4 Session Info 非目标
- 不提供 create-child 操作
- 不提供手动 writeback 操作
- 不提供 archive 操作
- 不提供 retry-sync 操作
- 不提供 role 编辑
- 不提供 prompt 编辑

## 4. 前端技术选型

### 4.1 框架与渲染栈
v1 已确认的前端技术栈：
- Next.js（App Router）
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- framer-motion

原因：
- 适合现代浏览器工作台形态
- 能支持高密度但不粗糙的应用 UI
- 适合作为独立前端应用存在，同时兼容分开部署和一体部署模式
- 有足够自由度避免做成传统中后台气质

### 4.2 包管理与运行时
已确认整体采用 Bun-first 方向。

项目将使用 Bun 作为：
- 包管理器
- workspace 管理器
- task runner
- 主运行时

边界说明：
- 目前假设 Bun 对本项目的 Node 兼容程度足够。
- 代码仍应尽量避免无必要地依赖过于特殊的 Bun-only API；只要标准 JS/TS 足够，就优先走标准方式。
- 如果未来发现某些问题只出现在 PI Agent SDK 集成上，可以再做工程调整，但当前设计默认按 Bun 全家桶推进。

### 4.3 前端状态策略
- 服务端数据使用 TanStack Query。
- 本地 UI 状态优先用 React state / context。
- 初期不引入重型全局状态方案。
- Zustand 不作为初始基线的一部分。

### 4.4 前端模块结构
前端按 feature 拆分，而不是按页面零散堆组件。

建议边界：
- `features/project-tree`
- `features/chat`
- `features/session-info`
- `features/auth`
- `features/layout-shell`

这样可以让工作台壳层稳定，同时各个能力独立演进。

## 5. 后端架构与模块边界

### 5.1 后端整体形态
后端与前端保持在同一个代码仓库中，但不与前端运行时耦合。

推荐结构：
- `apps/web` 提供独立前端应用
- `apps/api` 提供独立后端 API 服务
- 业务逻辑下沉到独立 package / service
- 与 PI 相关的 SDK 适配单独封装成一个 package

这样可以在同仓前提下，同时支持分开部署和一体部署，并避免把后端逻辑塞进前端运行时。

### 5.2 Workspace 结构
已确认项目采用 workspace 风格 monorepo，包含两个 app 和若干支持 packages。

推荐目录：
- `apps/web`
- `apps/api`
- `packages/db`
- `packages/domain`
- `packages/pi-client`
- `packages/ui`
- `packages/shared`

职责划分：
- `apps/web`：Next.js 前端应用
- `apps/api`：Hono + Bun 后端 API 服务、认证入口、流式 chat 代理入口
- `packages/db`：Drizzle schema、迁移配置、db 访问
- `packages/domain`：project、session、role、sync、audit 等领域服务
- `packages/pi-client`：PI Agent SDK adapter 与集成层
- `packages/ui`：共享视觉组件与设计基础件
- `packages/shared`：共享类型、DTO、常量、枚举、schema

逻辑后端分层：
- Web API 层：只服务前端 API
- Project 管理层：管理 project 生命周期与项目初始化流程
- 角色管理层：系统核心；维护 role / session 生命周期与 session tree 控制面真相
- PI SDK 层：只封装 PI SDK 能力
- Extension 注入层：把工具注入到 PI agent，并把 tool 调用转交给角色管理层
- DB：基于 SQLite 的控制面持久化
- Log：系统日志与运行日志，用于排障与运行追踪

### 5.3 HTTP / API 层职责
后端 HTTP 边界位于 `apps/api`，并使用 Hono + Bun 实现。

它应该负责：
- 认证请求
- 校验输入
- 调用 domain services
- 组织 response DTO
- 处理流式和普通请求响应协议

它不应该负责：
- 承载核心业务规则
- 直接内嵌 PI 编排逻辑
- 直接拥有复杂数据库查询逻辑（除极浅的 wiring）

`apps/web` 不得演化成第二套后端。无论是分开部署还是一体部署，核心业务真相都只能存在于 `apps/api`。

### 5.4 认证
已确认认证模型：
- 只支持本地账户
- 不做 OAuth
- v1 不做邮箱验证
- v1 不做找回密码

推荐库：
- `better-auth`

v1 认证范围：
- 如有需要，支持初始化首个管理员/首个用户的引导
- 登录
- 登出
- 基于 session 的服务端鉴权

v1 授权范围：
- project 仅创建者可见
- 不做 collaborator 模型
- 不做 team / org 模型
- 不做高级 RBAC

### 5.5 核心后端职责边界
- Web API 层只服务前端 API，保持为轻量协议边界。
- Project 管理层负责 project 的创建与查询，但不直接创建 session。
- 角色管理层是系统核心。它负责 role 生命周期、session 生命周期、prompt 拼装、session tree 维护、父子关系维护、writeback 目标解析，以及所有面向 PI 的执行决策。
- PI SDK 层只暴露被封装后的 PI 能力，不承载平台业务规则。
- Extension 注入层必须保持很薄：它负责注册工具、接收来自 PI 的工具调用、组装调用上下文，并把执行转交给角色管理层。它不维护 session tree，也不做业务编排。
- session tree 的控制面真相属于角色管理层，而不属于暴露给 LLM 的 tool 参数，也不属于 extension 层的临时状态。

## 6. PI Agent 集成与平台扩展

### 6.1 PI 适配层职责
PI Agent SDK 被视为底层执行引擎。

`packages/pi-client` 需要统一封装：
- 在 PI 中创建 session
- 从 PI 拉取消息历史
- 向 PI 发起流式消息发送
- 向 PI 下发停止请求
- 向 PI 注册 extension / tools
- 统一错误归一化和平台语义映射

PI 适配代码不能散落在页面或零散 route 文件中。

### 6.2 平台自有编排能力
由平台而不是 PI 持有的能力包括：
- role template 选择
- prompt 拼装
- parent-child session 血缘关系
- child session 创建语义
- 显式父节点 writeback 语义
- 本地副本和 sync 状态跟踪

因此，session 树本质上是平台维护的编排树，只是其节点恰好对应具体的 PI session。其权威控制面真相存在于角色管理层中，而不暴露给 LLM 的 tool 参数。父子关系、writeback 目标、role 生命周期以及 prompt 拼装都属于平台控制面决策。

### 6.3 平台扩展 tools
v1 需要在 PI 之上注入平台级扩展 tools。

最少包括：
- `spawn_session`
- `writeback_to_parent`

#### 6.3.1 spawn_session
用途：
- 基于当前 session 上下文创建子 session
- 接收已经被明确决策好的 role 和任务意图
- 基于 role 和 prompt 输入拼装最终 prompt
- 创建对应的 PI session
- 立即返回，而不是阻塞等待子 session 运行完成

面向 LLM 的输入字段：
- `role`
- `target`
- `constraints`

重要边界：
- `spawn_session` 不向 LLM 暴露父节点 id 或 session tree 结构
- 父节点由角色管理层根据当前执行上下文解析

行为要求：
- 一旦调用就直接执行，不再额外弹前端确认
- 是否应该执行，视为已在人与 LLM 的前期对话中隐式确认
- 同步校验 `role`、`target`、`constraints`
- 同步解析父上下文
- 同步拼装 prompt
- 同步创建本地 session 记录与 tree 关系
- 同步创建对应的 PI session
- 同步写入必要事件和日志
- 立即返回 `child_session_id`、`pi_session_id` 和创建状态
- 子 session 后续真正运行是异步的，不阻塞当前 tool 调用

#### 6.3.2 writeback_to_parent
用途：
- 显式把子 session 的结果摘要写回父 session

重要边界：
- tool 不要求 LLM 指定父 session id
- 父目标由角色管理层根据当前 session 上下文解析

行为要求：
- v1 默认不做普遍自动写回
- 大多数 session 预期都不会自动写回
- 写回是显式动作，由 tool 调用或用户/agent 意图触发
- 一旦调用就直接执行，不再额外弹前端确认
- v1 只支持写回父 session，不支持写回同项目任意 session
- writeback 由角色管理层同步执行
- writeback 必须真正进入父 `pi session`，同时本地数据库也要写入副本

#### 6.3.3 Tool 可用性策略
- v1 不做按 role 或按 session 的 tool allowlist。
- 平台 tools 由 PI 集成层统一加载。
- 平台此阶段不增加额外 tool 能力权限系统。

## 7. 数据层设计

### 7.1 数据层哲学
已确认的数据层方案是“中等控制面”设计。

含义：
- PI 是实时 chat 和运行态的真源。
- 本地数据库是持久化控制面模型和副本层。
- 本地数据库保存足够的信息，用来渲染左树、解释 session、保存 role 绑定与 prompt 快照、维护完整消息/事件副本、以及维护 sync / audit 状态。
- Chat 页面直接读 PI。
- Session Info 页面读本地数据。

这个方案刻意避开两个极端：
- 本地几乎不存东西、过于轻壳
- 一上来就做过重的 orchestration engine，把 run/job 拆得过细

### 7.2 数据库技术栈
已确认的数据层技术栈：
- SQLite
- Drizzle ORM
- Drizzle Kit

原因：
- 运维成本低
- 适合局域网优先的 v1 场景
- 对当前产品复杂度和请求规模足够
- 与 TypeScript 类型化 schema / migration 配合良好

### 7.3 核心表
v1 的核心表为：
- `users`
- `projects`
- `role_templates`
- `sessions`
- `messages`
- `session_events`
- `session_sync_states`
- `audit_events`

#### 7.3.1 users
字段：
- `id`
- `email`
- `password_hash`
- `name`
- `created_at`

职责：
- 表示本地账户身份
- 为认证、所有权和基础审计提供关联

#### 7.3.2 projects
字段：
- `id`
- `name`
- `created_by`
- `status`
- `archived_at`
- `archived_by`
- `last_activity_at`
- `created_at`
- `updated_at`

规则：
- Project 只是容器
- Project 没有根 chat
- v1 中 project 仅对创建者可见
- Project 支持 `active / archived` 可见性状态
- v1 不增加 `description` 字段

#### 7.3.3 role_templates
字段：
- `id`
- `key`
- `version`
- `name`
- `description`
- `base_prompt`
- `config_json`
- `created_by`（可空）
- `owner_type`
- `visibility`
- `is_builtin`
- `archived_at`（可空）
- `created_at`
- `updated_at`

规则：
- role template 需要版本化
- 新版本通过新增记录实现，而不是覆盖旧版本
- v1 在产品能力上只支持系统内置模板
- 但数据模型要为未来用户自定义模板预留空间
- v1 至少内置 `planner` 和 `blank`

`RoleTemplate.config_json` 在 v1 的范围：
- 只存最小运行配置
- 不做大而全的策略配置系统
- 预期字段可包含 model、temperature、max_output_tokens、类似 reasoning level 的值（如果 PI 支持）、少量 tool-use 提示，以及 metadata

#### 7.3.4 sessions
字段：
- `id`
- `project_id`
- `parent_session_id`（可空）
- `root_session_id`
- `depth`
- `role_template_id`
- `pi_session_id`
- `requested_by_message_id`（可空）
- `title`
- `title_source`
- `status`
- `runtime_status`
- `last_activity_at`
- `last_run_at`（可空）
- `last_stop_at`（可空）
- `last_runtime_error`（可空）
- `created_by`
- `archived_at`（可空）
- `archived_by`（可空）
- `created_at`
- `updated_at`

直接存放在 Session 上的 prompt 快照字段：
- `role_base_prompt_snapshot`
- `user_supplied_prompt`
- `parent_supplied_prompt`
- `compiled_prompt`

规则：
- 一个 session 精确映射一个 PI session
- 一个 session 绑定一个不可变的 role template 版本
- role 绑定创建后不可更改
- prompt 快照只在创建时写入，之后视为只读
- title 创建时先给默认值，后续可以生成建议标题，也可以被用户手动改名
- 一旦用户手动改名，之后任何自动逻辑都不能再覆盖

树结构语义：
- 一级 session 的 `parent_session_id = null`
- `root_session_id` 指向该血缘链最上层的根 session
- `depth` 显式保存
- 同级排序按 `last_activity_at`

标题语义：
- `title_source = default | generated | user`
- 默认 title 在 session 创建时产生
- 在前几轮对话后可生成建议标题
- 用户手动改名具有最高优先级

状态语义：
- `status = active | archived`
- `runtime_status = idle | running | stopping | error`

这两个维度必须分开，不得混用。

#### 7.3.5 messages
字段：
- `id`
- `session_id`
- `pi_message_id`（可空）
- `message_kind`
- `source_session_id`（可空）
- `role`
- `content_text`
- `content_blocks_json`（可空）
- `content_version`
- `created_at`

规则：
- 本地 `messages` 是副本，不是 chat 页面的主渲染真源
- `role` 的取值为 `user | assistant | system`
- `message_kind` 的取值为 `normal | writeback`
- 写回消息在 UI 上表现为 assistant 消息，但带明确来源标识
- `content_text` 是主要可读文本
- `content_blocks_json` 为未来结构化富内容扩展预留
- v1 不引入附件 / 文件模型

#### 7.3.6 session_events
字段：
- `id`
- `session_id`
- `type`
- `payload`
- `parent_message_id`（可空）
- `sequence`
- `created_at`

职责：
- 保存运行过程与控制面事件时间线
- 让运行细节与聊天消息流保持分离

v1 预期事件家族至少包括：
- `spawn_requested`
- `child_session_created`
- `sync_started`
- `sync_completed`
- `sync_failed`
- `writeback_requested`
- `writeback_written`
- `writeback_failed`
- `error`

#### 7.3.7 session_sync_states
字段：
- `session_id`
- `sync_status`
- `last_synced_at`
- `last_pi_message_id`
- `last_pi_event_id`（可空）
- `last_error`（可空）
- `retry_count`
- `updated_at`

职责：
- 独立跟踪控制面副本同步位置与同步健康状态

规则：
- sync state 不是 session 本体业务身份的一部分
- 它需要单独建模，以支持未来的重试、修复和排障

#### 7.3.8 audit_events
字段：
- `id`
- `user_id`
- `action`
- `target_type`
- `target_id`
- `payload`
- `created_at`

v1 审计范围：
- 记录登录
- 记录 project 创建、session 创建、fork、archive 等变更动作
- 不记录普通查看行为

### 7.4 Session 创建规则
#### 7.4.1 Project 初始化
新建 project 后，系统会自动创建一个一级 Planner session。

初始化边界：
- Project 管理层负责创建 project 本体
- Project 管理层不直接创建默认 session
- 它会调用角色管理层去创建默认 Planner session

创建 project 后的前端刷新策略：
- 创建 project 的接口不需要返回已经拼好的树，也不需要返回默认 session 摘要
- 前端在创建成功后，直接重新拉取完整的 project / session tree
- 前端不做复杂树拼接

#### 7.4.2 手动创建 session
用户可以在 project 下手动创建一个一级 Blank session。

创建边界：
- 一级 Blank session 的创建同样统一走角色管理层
- 前端刷新策略与 project 创建一致：创建成功后直接重新拉取完整 tree

Blank role 的语义：
- Blank 是一个正式内置 role template，不是无角色 session
- Blank 尽量保持最小约束，不过度带流程或人格
- Blank 与其他 role 一样，绑定后不可修改

#### 7.4.3 Child session 创建
- child session 通过平台编排 / tool 创建
- child session 是独立 session，拥有自己的 PI session 和不可变 role 绑定
- child session 与其他 session 一样，统一进入同一张 `sessions` 表和同一棵树
- 所有 session 创建路径都归角色管理层统一持有，包括项目默认 session、用户手动创建的一级 Blank session，以及 `spawn_session` 创建的子 session

### 7.5 副本与同步行为
#### 7.5.1 消息真源模型
- PI 是聊天历史的真源。
- 本地数据库保存完整副本供平台使用。
- 如果出现漂移，本地副本可以被修复或重建。
- 当两边不一致时，以 PI 为准。

#### 7.5.2 同步策略
已确认的同步策略是“主动写入 + 可修复”：
- session 运行时，后端会在流式过程中写入本地副本
- 在需要时，可以基于 PI 状态做轻量对账和修复
- Session Info 和平台诊断依赖本地 sync state 模型

#### 7.5.3 活跃时间更新规则
以下动作应更新 `last_activity_at`：
- 新消息到达
- 新的相关 session event 写入
- 创建 child session
- 向 parent 写回
- 一次带来新内容的 sync 完成

`projects` 和 `sessions` 都需要维护 `last_activity_at`，以支撑最近活跃优先的树排序。

## 8. 运行时与交互规则

### 8.1 单 session 并发规则
- 同一个 session 不能同时处理多条并发发送。
- 当 `runtime_status` 为 `running` 或 `stopping` 时，前端必须阻止再次发送。
- 停止行为必须真正下发到底层 PI，而不是只在 UI 上取消订阅。

### 8.2 后台运行与页面切换
- 运行中的 session 可以在用户切走页面后继续运行。
- 树中的运行状态必须独立于当前页面焦点。
- 用户回到一个运行中的 session 时，应能重新接上它的可见输出流。

### 8.3 归档语义
- Archive 是生命周期 / 可见性操作，不是真删除。
- Project 和 Session 只能归档，不能在 v1 中被真删除。
- Message 和 SessionEvent 不提供手工删除。
- 归档 session 仍属于原有树血缘关系，可按原位置显示。

### 8.4 Writeback 语义
- v1 不把自动 writeback 作为默认普遍机制。
- 大多数 child session 预期都不会自动写回。
- 显式 writeback 通过专门 tool 支持。
- v1 只允许写回 parent session。
- 写回结果在父 chat 中表现为一条 assistant 消息，并带 writeback 标记与 `source_session_id`。
- 写回内容既要有可读文本，也允许同时带结构化摘要块。

## 9. 技术决策摘要

已确认的技术基线：
- Bun workspaces
- Next.js App Router
- React + TypeScript
- Tailwind CSS
- shadcn/ui
- framer-motion
- TanStack Query
- Hono + Bun 作为后端 API 服务
- better-auth
- SQLite
- Drizzle ORM / Drizzle Kit
- PI Agent SDK adapter 独立放在 `packages/pi-client`
- `apps/api` 作为后端 HTTP 边界
- domain services 独立放在 `packages/domain`
- 同时支持前后端分开部署与前后端一体部署

## 10. 明确延后的内容

以下内容明确不进入 v1 基线设计：
- 高级 RBAC
- teams / organizations / collaborators
- project 描述与更多 project 元数据
- role-template 管理 UI
- 用户自定义 role template 的产品能力
- 附件 / 文件模型
- 重型 operations console
- tool allowlist 或按 role 的 tool 权限策略
- SessionRun / Job 建模
- 自动化多策略 writeback 编排
- 单 session 内的 message-thread 分叉
- 桌面壳打包
- 为非 chat 实时功能建立全站 WebSocket 基础设施

## 11. API 设计基线

本节固化前端公开 API 形态与实时协议基线。

### 11.1 公开 API 与内部平台动作的分离
前端公开 API 与平台内部动作必须分开。

前端公开 API 包括：
- auth APIs
- tree / project / session 查询 APIs
- chat 历史与 send / stop APIs
- session archive API

平台内部动作包括：
- spawn_session
- writeback_to_parent

spawn_session 与 writeback_to_parent 不属于前端主公开 API，它们是通过 extension / tool 链路触发、再由角色管理层执行的内部编排能力。

### 11.2 HTTP API 基线
- 统一基础路径：`/api/v1`
- `apps/api` 是唯一后端 HTTP 边界
- `apps/web` 只消费 `apps/api`，不再实现第二套业务后端表面
- 查询与写操作通过普通 HTTP endpoint 暴露
- chat 发送走 HTTP mutation
- chat 输出通过 WebSocket 的流式帧返回

### 11.3 错误响应格式
前端公开 HTTP API 使用统一错误格式：

```json
{
  "error": {
    "code": "SESSION_BUSY",
    "message": "Session is currently running and cannot accept a new message.",
    "details": {}
  }
}
```

规则：
- 成功响应不强制包一层 `success: true`
- 错误统一暴露 `error.code`、`error.message` 与可选的 `error.details`

### 11.4 HTTP 查询 APIs
#### 11.4.1 GET /api/v1/tree
用途：
- 返回当前用户可见的完整 `project + session tree`

规则：
- tree 的完整嵌套结构由后端直接拼装
- 排序、节点塑形、层级构造全部由后端负责
- 响应默认包含 archived sessions 在内的全量树
- 前端只负责 archived 显隐过滤
- 前端不在本地重建树结构

#### 11.4.2 GET /api/v1/sessions/:sessionId/info
用途：
- 返回当前 session 的完整 Session Info 聚合数据

规则：
- 这是一个聚合接口
- 前端不自己拼多个 info 接口
- 只有进入 Session Info tab 时才调用

预期返回至少包括：
- session overview
- role template 摘要
- prompt 快照
- sync 状态
- 最近事件

#### 11.4.3 GET /api/v1/sessions/:sessionId/chat/messages
用途：
- 返回当前 session 的 chat 历史

规则：
- chat 历史真源来自 PI
- 前端统一按 cursor 分页模型使用
- 如果 PI 支持原生分页，后端直接做适配
- 如果 PI 不支持分页，后端可以一次取全量或当前可取到的完整历史，做短时缓存，再本地切片为 cursor 分页
- 如果 PI 不提供稳定 message id，后端可以生成临时 cursor

### 11.5 HTTP 写操作 APIs
#### 11.5.1 POST /api/v1/projects
用途：
- 创建 project

规则：
- project 创建后永远自动创建一个一级默认 Planner session
- 前端不能通过请求参数控制这个行为
- 响应不需要返回已经拼好的树，也不需要返回默认 session 摘要
- 成功后前端直接重拉完整 tree

#### 11.5.2 POST /api/v1/projects/:projectId/sessions
用途：
- 在 project 下创建一个一级 Blank session

规则：
- 创建统一走角色管理层
- 成功后前端直接重拉完整 tree

#### 11.5.3 POST /api/v1/sessions/:sessionId/chat/messages
用途：
- 向当前 session 发送一条新的用户消息

规则：
- 这是一个命令型写操作
- 请求成功只表示已受理并开始处理
- 实际 assistant 输出通过 WebSocket `chat_stream` 返回
- 如果当前 session 已处于 `running` 或 `stopping`，则直接返回错误，不排队第二条发送

#### 11.5.4 POST /api/v1/sessions/:sessionId/stop
用途：
- 停止当前运行中的 session

规则：
- 必须真正下发到底层 PI，而不是只取消前端显示
- 对应前端“两次 Esc 停止”的交互路径

#### 11.5.5 POST /api/v1/sessions/:sessionId/archive
用途：
- 归档 session

规则：
- v1 前端公开 API 只开放 session archive，不开放 project archive
- 成功后前端直接重拉完整 tree

### 11.6 WebSocket 基线
前端登录后建立一条按用户作用域的 WebSocket 连接。

规则：
- 登录后建立连接
- 默认存在一条全局用户级事件流
- 前端通过显式上下文更新告诉后端当前 project / session / tab
- 前端不直连 PI

### 11.7 WebSocket 下行消息类型
实时消息拆成两类。

#### 11.7.1 控制面事件
控制面事件使用统一 envelope：

```json
{
  "kind": "event",
  "type": "session.created",
  "timestamp": "2026-06-02T12:34:56.000Z",
  "scope": {
    "project_id": "p_123",
    "session_id": "s_456"
  },
  "payload": {}
}
```

事件示例：
- `project.created`
- `project.updated`
- `session.created`
- `session.updated`
- `session.archived`
- `tree.changed`
- `session.runtime_status_changed`
- `session.writeback.received`
- `session.sync_status_changed`

#### 11.7.2 Chat 流式帧
chat 输出不是普通控制面事件，而是单独的 `chat_stream` 消息族。

结构如下：

```json
{
  "kind": "chat_stream",
  "phase": "delta",
  "timestamp": "2026-06-02T12:34:56.100Z",
  "scope": {
    "session_id": "s_456"
  },
  "payload": {
    "stream_id": "st_001",
    "message_id": "m_001",
    "delta": "hello",
    "blocks": null
  }
}
```

规则：
- `phase` 取值为 `start | delta | complete | error`
- `delta` 以文本增量为主
- `blocks` 可空，为结构化扩展预留

### 11.8 WebSocket 上行客户端消息
前端到后端的 WebSocket 消息最少支持：
- `hello`
- `set_context`
- `ping`

上下文更新结构：

```json
{
  "kind": "client",
  "type": "set_context",
  "payload": {
    "project_id": "p_123",
    "session_id": "s_456",
    "current_tab": "chat"
  }
}
```

规则：
- 当前上下文由前端显式推送给后端
- `project_id`、`session_id`、`current_tab` 三者都保留，方便后续扩展

### 11.9 实时推送规则
- 全局用户级连接接收全局控制面事件
- `set_context` 之后，当前上下文进入增强订阅模式
- 当 `current_tab = chat` 时，后端可以为当前 session 推送细粒度 `chat_stream:delta`
- 当 `current_tab = session_info` 时，后端不推细粒度 chat delta，只推摘要级状态变化
- 对于后台运行、但当前未打开的 session，只推摘要级状态变化，不推完整 token 流

### 11.10 Chat 加载与流式模型
已确认的 chat 主链路：
1. 前端进入 Chat tab
2. 前端通过 HTTP 拉最近一段历史
3. 前端通过 HTTP 发起一条新消息
4. 后端通过 WebSocket 推 `chat_stream:start`
5. 后端通过 WebSocket 推多个 `chat_stream:delta`
6. 后端通过 WebSocket 推 `chat_stream:complete` 或 `chat_stream:error`

这样可以把历史加载和实时流明确分开。

## 12. 推荐的下一步

在本文档之后，下一阶段应进入实现计划编写。当前已经固定下来的内容包括：
- 前端壳与交互模型
- 后端模块边界
- 数据模型
- 前端公开 HTTP API 基线
- WebSocket 协议基线
- 内部 spawn / writeback 编排边界

本文档应作为后续实现决策的权威基线。
