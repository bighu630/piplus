# Session-Scoped Model Selection Design

日期：2026-06-15

## 1. 目标

为当前项目增加“会话级模型选择”能力，直接借用 `pi SDK` 的原生模型管理，不自行发明新的模型管理系统。

## 2. 作用范围

仅影响**当前 session**，不影响：
- 同项目下其他 session
- 全局默认模型
- 其他用户（当前系统是单用户）

## 3. UI 位置

放在**右侧聊天区顶部标题栏右侧**。

示意：

```txt
项目_05                             [ DeepSeek V4 Flash ▾ ]
当前正与 Worker 对话
```

## 4. 后端接口

### 4.1 获取可用模型

```http
GET /api/v1/models
```

返回：

```json
{
  "models": [
    { "provider": "deepseek", "id": "deepseek-v4-flash", "label": "DeepSeek V4 Flash" },
    { "provider": "deepseek", "id": "deepseek-v4-pro", "label": "DeepSeek V4 Pro" },
    { "provider": "neco", "id": "gpt-5.5", "label": "GPT-5.5" }
  ]
}
```

来源：`ModelRegistry.getAvailable()`。

### 4.2 切换当前 session 模型

```http
POST /api/v1/sessions/:sessionId/model
```

请求：

```json
{
  "provider": "deepseek",
  "id": "deepseek-v4-flash"
}
```

行为：
1. 校验 session 属于当前用户
2. `restoreRuntime(sessionId, locator)`
3. 找到目标 model
4. `agentSession.setModel(model)`
5. 返回当前模型信息

响应：

```json
{
  "session_id": "session_xxx",
  "model": {
    "provider": "deepseek",
    "id": "deepseek-v4-flash",
    "label": "DeepSeek V4 Flash"
  }
}
```

## 5. runtime / pi-client 设计

### 新增能力

```ts
listAvailableModels(): Promise<Array<{
  provider: string;
  id: string;
  label: string;
}>>

getCurrentModel(sessionId: string): Promise<{
  provider: string;
  id: string;
  label: string;
} | null>

setSessionModel(
  sessionId: string,
  locator: PiSessionLocator,
  modelRef: { provider: string; id: string }
): Promise<{
  provider: string;
  id: string;
  label: string;
}>
```

### 行为

- `restoreRuntime()` 后保证有 `agentSession`
- `setSessionModel()` 内部调用 `agentSession.setModel(model)`
- `getCurrentModel()` 从 runtime session 读当前 model
- `listAvailableModels()` 直接读 `ModelRegistry.getAvailable()`

## 6. 忙碌状态规则

如果当前 session 正在运行（streaming），禁止切模型：

```http
409 SESSION_BUSY
```

前端提示：

```txt
当前会话正在运行，请等待完成后再切换模型
```

## 7. 持久化策略

第一阶段不额外写数据库字段，先借用 pi session 自己的持久化能力。

也就是说：
- `setModel()` 后如果 pi session 文件能持久化 model change
- 下次 `restoreRuntime()` 时自动恢复

不增加 `selected_model_provider` / `selected_model_id` 字段。

## 8. Session Info 展示

第一阶段建议在 `SessionInfoPanel` 中显示：
- 当前模型 label
- provider
- model id

用于调试和可见性。

## 9. 不做的事

- 项目级统一模型
- 全局默认模型 UI
- 运行中切模型
- 自己的一套 provider/model registry

## 10. 结论

这次功能按“会话级模型选择”落地，前端入口放在聊天区顶部标题栏右侧，底层完全借用 `pi SDK` 的模型管理能力。这样实现最小、语义最清晰，也最符合当前 `session → runtime` 的架构。
