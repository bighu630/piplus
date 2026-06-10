# Piplus Pi Client Session Gateway Design

日期：2026-06-10

## 1. 背景

当前 `packages/pi-client` 只是一个内存 stub：

- `createSession()` 仅在进程内 `Map` 中创建会话
- `sendMessage()` 直接写入回声消息
- `listMessages()` 从内存数组分页
- `stopSession()` 仅切换布尔标记
- 不支持 `pi SDK` 的真实会话恢复、流式输出、fork、历史树读取与 runtime 生命周期管理

而当前项目的核心业务模型已经是“项目 -> 会话树 -> 实时运行状态”，因此继续使用内存 stub 会阻塞以下能力：

- 基于业务 `sessionId` 恢复真实会话
- 从会话文件读取完整历史
- fork 会话生成新业务 session
- 订阅并转发流式输出
- 多会话并发运行

本设计目标是将 `packages/pi-client` 升级为基于 `pi SDK` 的完整会话网关。

## 2. 目标

本次设计覆盖以下目标：

- 保持业务主键为现有数据库中的 `sessionId`
- 使用真实 `pi SDK` 替换当前内存 stub
- 为每个业务 session 独立创建或恢复 runtime
- 历史消息与会话树以 `pi` session 文件为准
- fork 后生成新的业务 session，而不是在原 session 内切分支
- 向上层隐藏 `SessionManager`、`AgentSessionRuntime` 与 SDK 事件细节
- 支持多个会话同时活跃，不使用全局 runtime 切换

## 3. 非目标

第一阶段不包含以下内容：

- runtime 自动回收策略（TTL、LRU、内存上限）
- 指定 `entryId` fork 的完整 UI 能力
- 自定义工具运行时与扩展绑定的完整编排
- compaction、navigateTree、steer/followUp 的产品化封装
- 跨进程 runtime 共享

## 4. 设计原则

### 4.1 业务主键不变

业务层继续使用现有数据库 `sessions.id` 作为唯一主键。API、domain、web 端不直接使用 `pi` 的 `sessionId` 或 session 文件路径作为主键。

### 4.2 历史以文件为准

会话完整历史、树结构、branch 来源等信息以 `pi` session 文件为唯一真实来源。数据库只保存业务投影与定位信息，不复制完整历史。

### 4.3 运行时与历史读取解耦

历史读取不依赖活跃 runtime。即使一个业务 session 当前没有 runtime，也必须能够从 `pi` session 文件读取历史。

### 4.4 不做全局 runtime 切换

不使用单个 `AgentSessionRuntime` 进行 `switchSession()` 驱动的 UI 模式。每个活跃业务 session 有自己的独立 runtime，避免多会话 UI 与底层当前激活 session 状态错位。

## 5. 数据模型

### 5.1 数据库存储

当前数据库中的 `sessions` 记录需要新增一个可扩展字段：

- `pi_session_locator_json`

该字段用于持久化业务 `sessionId` 对应的 `pi` 会话定位信息。

第一阶段建议结构：

```json
{
  "piSessionId": "optional-sdk-session-id",
  "sessionFile": "/absolute/or/resolved/path/to/session.jsonl"
}
```

说明：

- 第一阶段允许内部仅依赖 `sessionFile`
- `piSessionId` 可作为附加调试信息或后续扩展字段
- 字段命名使用 `locator` 而不是 `path`，避免未来被单一存储形式锁死

### 5.2 运行时内存索引

`pi-client` 在进程内维护一个 runtime 注册表，按业务 `sessionId` 建立映射：

```ts
Map<string, ActiveSessionRuntime>
```

建议的运行时记录结构：

```ts
type ActiveSessionRuntime = {
  sessionId: string;
  locator: PiSessionLocator;
  runtime: AgentSessionRuntime;
  unsubscribe?: () => void;
  createdAt: number;
  lastActiveAt: number;
};
```

第一阶段不定义自动清理策略，但保留 `lastActiveAt` 等字段，为后续回收打基础。

## 6. 分层设计

`packages/pi-client` 作为完整会话网关，对外暴露业务语义接口，内部拆分为两层。

### 6.1 Session Store Adapter

职责：

- 使用 `SessionManager` 创建持久化 session
- 根据 locator 打开已有 session 文件
- 列举历史、读取路径、读取树、读取叶子信息
- 执行 fork 并返回新的 session 文件

它不负责流式运行与消息发送。

### 6.2 Runtime Manager

职责：

- 为业务 `sessionId` 创建或恢复独立 runtime
- 管理 `session.subscribe()` 订阅
- 发送 prompt
- 转发流事件
- 停止运行
- 手动关闭 runtime

它不直接决定数据库如何存储业务关系。

### 6.3 Facade / Gateway

对上层暴露统一接口，例如：

- `createBusinessSessionRuntime(...)`
- `restoreRuntime(sessionId, locator)`
- `subscribeSession(sessionId, listener)`
- `sendMessage(sessionId, content)`
- `getHistory(sessionId, cursor, limit)`
- `forkSession(sessionId, locator, entryId?)`
- `stopSession(sessionId)`
- `closeRuntime(sessionId)`

上层 `domain` 和 `api` 不直接感知 `SessionManager`、`AgentSessionRuntime`、`session.subscribe()`。

## 7. Runtime 模型

### 7.1 创建

当业务层创建一个新 session 时：

1. `pi-client` 使用 `SessionManager.create(cwd)` 或等价方式创建新的持久化 session
2. 基于 SDK 创建 `AgentSessionRuntime`
3. 提取 locator
4. 返回 locator 给业务层持久化到 `pi_session_locator_json`

### 7.2 恢复

当用户激活一个已有业务 session 时：

1. 上层根据业务 `sessionId` 读出 `pi_session_locator_json`
2. `pi-client` 检查该 `sessionId` 是否已有活跃 runtime
3. 若已有，则直接复用
4. 若没有，则根据 locator 恢复 runtime 并建立订阅

### 7.3 订阅

每个活跃 runtime 必须支持显式流订阅接口：

- `subscribeSession(sessionId, listener)`
- 返回取消订阅函数
- 一个业务 session 可被多个上层监听者同时订阅
- 订阅推送的事件必须至少带 `sessionId` 与 `runId`
- 如 SDK 可提供稳定消息标识，则事件中同时携带 `messageId`

该接口是页面实时渲染的主数据链路。

### 7.4 复用

后续对该 `sessionId` 的消息发送、停止操作、流事件订阅都复用同一个活跃 runtime，直到显式关闭。

### 7.5 关闭

第一阶段只要求支持手动关闭：

- `closeRuntime(sessionId)`
- 释放订阅
- 调用 runtime/session 的清理逻辑
- 从内存注册表删除

自动关闭策略留待后续设计。

## 8. 历史读取

### 8.1 数据来源

`GET /chat/messages` 不再依赖当前内存 stub，也不再以数据库消息表作为完整消息源，而是从 `pi` session 文件读取。

### 8.2 读取方式

通过 `SessionManager.open(sessionFile)` 获取树与路径信息，再将 active path 或需要展示的消息映射成现有前端 DTO。

### 8.3 DTO 映射

SDK 消息结构需要映射到当前共享 DTO，例如：

- `user` -> `ChatMessageDTO.role = 'user'`
- `assistant` -> `ChatMessageDTO.role = 'assistant'`
- message text -> `content_text`
- entry/message 标识 -> `id`

如果 `pi` 的某些事件或消息类型无法一一对应当前 DTO，第一阶段优先保证普通用户/助手文本消息可读。

## 9. 消息发送与流式事件

### 9.1 实时链路原则

页面实时渲染以流式订阅为主链路，而不是以历史接口轮询为主链路。

标准路径为：

1. 页面通过后端 websocket 订阅业务 `sessionId`
2. API 层为该 `sessionId` 建立或复用 `pi-client.subscribeSession(...)`
3. 用户发送消息后，API 层调用 `pi-client.sendMessage(sessionId, content)`
4. `pi-client` 从 `session.subscribe()` 接收 SDK 增量事件
5. API 层将标准化流事件广播到现有 websocket hub
6. 前端根据 `start/delta/complete/error` 实时渲染
7. 历史接口仅用于补历史与断线恢复

### 9.2 发送入口

`sendMessage(sessionId, content)` 的行为：

1. 获取或恢复对应 runtime
2. 为本次运行生成并返回 `runId`
3. 调用 `runtime.session.prompt(content)` 或等价消息发送接口
4. 流式事件通过已建立的订阅链路异步向上层推送，而不是通过本次调用参数内联回调

### 9.3 标准化流事件

`pi-client` 对上层至少输出以下标准化事件：

- `message_start`
- `text_delta`
- `message_end`
- `error`

每个事件必须至少包含：

- `sessionId`
- `runId`

如 SDK 能提供稳定消息标识，则同时包含：

- `messageId`

可选扩展事件：

- `tool_start`
- `tool_update`
- `tool_end`
- `agent_start`
- `agent_end`

### 9.4 事件映射

SDK 事件到业务事件的建议映射如下：

- `message_start` -> `chat_stream start`
- `message_update` 中 `text_delta` -> `chat_stream delta`
- `message_end` 或 `agent_end` -> `chat_stream complete`
- 错误 / 中断 -> `chat_stream error`
- 可选：tool 生命周期 -> 系统事件或调试事件

### 9.5 WebSocket 对接

后端现有 websocket hub 继续作为对前端的统一事件出口。`pi-client` 不直接感知 Hono websocket 细节，而是通过订阅回调把标准化事件交给上层，由 API 层广播。

## 10. 停止运行

当前业务有 `stopSession(sessionId)` 语义。接入真实 SDK 后：

- 应优先映射到 `session.abort()` 或 runtime 对应取消机制
- 运行状态从 `running` -> `stopping` -> `idle` 的业务投影，仍由上层 API/domain 控制
- `pi-client` 负责提供底层取消动作与必要事件反馈

第一阶段不要求定义复杂的“安全停止”协议，只要求中断当前运行并正确回收状态。

## 11. Fork 设计

### 11.1 对外语义

接口签名直接支持：

```ts
forkSession(sessionId: string, locator: PiSessionLocator, entryId?: string)
```

语义：

- 未传 `entryId`：从当前叶子 fork
- 传入 `entryId`：从指定历史节点 fork

### 11.2 第一阶段实现范围

第一阶段仅实现“从当前叶子 fork”。但接口保留 `entryId` 参数，避免后续再改 public API。

### 11.3 fork 结果

fork 流程：

1. 根据源业务 session 的 locator 打开源 session
2. 从当前叶子创建 branched session 文件
3. 生成新的 locator
4. 业务层创建新的 session 记录
5. 新 session 持久化自己的 `pi_session_locator_json`
6. 源 session 保持不变

这意味着 `fork` 在业务上始终产出一个新的 session，而不是修改原 session 的当前分支。

## 12. API 与 Domain 的影响

### 12.1 packages/domain

`domain` 层继续处理：

- 项目与会话的业务关系
- parent/root/depth 等树元数据
- fork 后新业务 session 的创建
- 权限检查
- 审计记录

它不处理 SDK runtime 生命周期。

### 12.2 apps/api

`api` 层继续处理：

- HTTP 参数解析
- 用户鉴权
- DTO 映射
- websocket 广播
- 调用 domain 与 `pi-client` 网关

但 `apps/api/src/routes/sessions.ts` 的历史读取、消息发送和停止逻辑将从当前“直接查库 + stub client”迁移到“调用真实网关”。

## 13. 并发与错误处理

### 13.1 并发模型

允许多个业务 session 同时拥有活跃 runtime。每个 runtime 只服务自己的业务 `sessionId`。

### 13.2 同 session 并发发送

第一阶段应禁止同一 `sessionId` 在一次运行未结束前再次发起新的 prompt。若发生并发发送，请返回业务层可识别的 busy 错误。

### 13.3 恢复失败

若 locator 对应文件不存在、无法打开或格式损坏：

- `pi-client` 抛出明确错误类型
- 上层将其转换为业务错误（例如 session runtime unavailable）
- 不自动静默创建新会话，避免历史丢失被掩盖

### 13.4 流中断

若流式处理过程中 SDK 抛错或被 abort：

- `pi-client` 应发出统一错误/结束事件
- 上层负责把运行态投影恢复到一致状态

## 14. 第一阶段交付范围

第一阶段需要完成：

- 用真实 `pi SDK` 替换当前内存 stub
- 新增 `pi_session_locator_json` 存储
- 支持创建业务 session 时建立真实 `pi` session
- 支持根据 locator 恢复 runtime
- 支持向 session 发送消息
- 支持显式流订阅接口与流式输出事件桥接
- 支持从 session 文件读取历史
- 支持 stop/abort
- 支持从当前叶子 fork 为新业务 session

## 15. 测试策略

至少覆盖以下测试：

- 创建新业务 session 时能得到有效 locator
- 关闭 runtime 后，仍可从文件读取历史
- 根据已有 locator 能恢复 runtime 并继续发送消息
- 同一个业务 session 重复恢复时复用已有 runtime
- 消息发送能产生流式 delta 事件
- stop/abort 后运行态正确结束
- fork 后生成新的 locator，且源 session 历史不丢失
- locator 无效时返回明确错误

## 16. 风险与后续工作

### 16.1 资源回收

按 session 持有独立 runtime 符合当前产品模型，但如果长期不回收，后续会带来内存与句柄占用问题。需要在后续版本设计 TTL/LRU 机制。

### 16.2 文件路径稳定性

第一阶段 locator 里若保存 `sessionFile`，需要确认部署环境中的路径稳定性。后续如有环境迁移诉求，可升级 locator 为逻辑引用而非硬编码路径。

### 16.3 DTO 兼容性

`pi` session 文件中的消息/树结构不一定与当前前端 DTO 一一对应。第一阶段以“普通消息可用”为先，复杂节点或系统事件可后续补充。

## 17. 结论

`packages/pi-client` 应从当前内存 stub 演进为基于 `pi SDK` 的完整会话网关，采用“业务 `sessionId` 主键 + `pi_session_locator_json` 持久化定位 + 每个活跃 session 独立 runtime + 历史从 session 文件读取”的架构。该方案与当前产品的多会话 UI、会话树模型和实时流式交互最匹配，并为后续 fork、恢复、回收策略和更丰富的运行时能力留出了扩展空间。
