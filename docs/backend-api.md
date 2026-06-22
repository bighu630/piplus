# Piplus 后端接口文档

本文档根据当前后端实现整理，覆盖 `HTTP API` 与 `WebSocket` 协议。项目后端基于 `Hono + Bun + TypeScript`。

## 基本信息

- 服务健康检查：`GET /health`
- API 前缀：`/api/v1`
- 默认 `Content-Type`：`application/json`
- 鉴权方式：`Authorization: Bearer <token>`
- 开发/测试环境兜底鉴权：`x-user-id: <userId>`（仅 `NODE_ENV !== production` 时可用）

## 通用响应约定

成功响应通常直接返回业务对象；失败响应统一为：

```json
{
  "error": {
    "code": "UNAUTHENTICATED",
    "message": "Missing or invalid token"
  }
}
```

常见错误码：

| 错误码 | HTTP 状态码 | 说明 |
| --- | --- | --- |
| `UNAUTHENTICATED` | `401` | 未登录或 Token 无效 |
| `INVALID_PASSWORD` | `401` | 登录密码错误 |
| `NOT_FOUND` | `404` | 项目或会话不存在，或无访问权限 |
| `INVALID_PATH` | `400` | 项目路径为空 |
| `PATH_NOT_FOUND` | `400` | 指定目录不存在 |
| `INVALID_URL` | `400` | Git 仓库地址为空 |
| `PATH_EXISTS` | `409` | Git clone 目标目录已存在 |
| `CLONE_FAILED` | `500` | Git clone 执行失败 |
| `EMPTY_MESSAGE` | `400` | 发送消息内容为空 |
| `SESSION_BUSY` | `409` | 会话正在运行或停止中 |
| `MODEL_NOT_FOUND` | `404` | 指定模型不存在 |
| `INVALID_TITLE` | `400` | 会话标题不合法 |

## 鉴权接口

### 登录 `POST /api/v1/auth/login`

使用本地密码换取访问 Token。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `password` | `string` | 是 | 本地登录密码，默认值为 `piplus-local`，可通过 `APP_PASSWORD` 覆盖 |

请求示例：

```json
{
  "password": "piplus-local"
}
```

成功响应示例：

```json
{
  "token": "mbrp6wz1.abc123",
  "user": {
    "id": "local-user",
    "name": "Piplus"
  }
}
```

### 登录态校验 `GET /api/v1/auth/check`

请求头：

| Header | 必填 | 说明 |
| --- | --- | --- |
| `Authorization` | 是 | `Bearer <token>` |

成功响应示例：

```json
{
  "ok": true,
  "user": {
    "id": "local-user",
    "name": "Piplus"
  }
}
```

## 项目接口

### 创建项目 `POST /api/v1/projects`

说明：创建项目，并自动创建一个 planner 顶层会话。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `name` | `string` | 否 | 项目名称，默认 `Untitled Project` |
| `mode` | `string` | 否 | `existing` 或 `git_clone`，默认 `existing` |
| `path` | `string` | 条件必填 | `mode=existing` 时必填，本地项目目录 |
| `repo_url` | `string` | 条件必填 | `mode=git_clone` 时必填，Git 仓库地址 |

`existing` 模式请求示例：

```json
{
  "name": "API Project",
  "mode": "existing",
  "path": "/tmp"
}
```

`git_clone` 模式请求示例：

```json
{
  "mode": "git_clone",
  "repo_url": "https://github.com/example/repo.git"
}
```

成功响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `projectId` | `string` | 新建项目 ID |
| `sessionId` | `string` | 自动创建的 planner 会话 ID |
| `piSessionId` | `string` | 底层 Pi 会话 ID（若服务层返回） |

### 创建项目顶层会话 `POST /api/v1/projects/:projectId/sessions`

说明：在指定项目下创建新的顶层 blank session。

路径参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `projectId` | `string` | 项目 ID |

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `inherit_model` | `object \| null` | 否 | 新会话继承的模型信息 |
| `inherit_model.provider` | `string` | 否 | 模型提供商 |
| `inherit_model.id` | `string` | 否 | 模型 ID |

请求示例：

```json
{
  "inherit_model": {
    "provider": "openai",
    "id": "gpt-4.1"
  }
}
```

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "project_id": "project_xxx"
}
```

### 归档项目 `POST /api/v1/projects/:projectId/archive`

说明：归档项目，同时将该项目下所有会话标记为归档。

成功响应示例：

```json
{
  "project_id": "project_xxx",
  "status": "archived"
}
```

### 删除项目 `DELETE /api/v1/projects/:projectId`

说明：删除项目及其关联会话、消息、会话事件、同步状态。

成功响应示例：

```json
{
  "project_id": "project_xxx",
  "status": "deleted"
}
```

## 树形数据接口

### 获取项目树 `GET /api/v1/tree`

说明：返回当前用户下的项目树及会话树，按后端结构直接组织。

成功响应示例：

```json
{
  "projects": [
    {
      "id": "project_xxx",
      "name": "Tree Project",
      "status": "active",
      "archived_at": null,
      "last_activity_at": "2026-06-22T00:00:00.000Z",
      "created_at": "2026-06-22T00:00:00.000Z",
      "sessions": [
        {
          "id": "session_xxx",
          "project_id": "project_xxx",
          "parent_session_id": null,
          "root_session_id": "session_xxx",
          "depth": 0,
          "role_template_key": "planner",
          "title": "Planner Session",
          "status": "active",
          "runtime_status": "idle",
          "archived_at": null,
          "last_activity_at": "2026-06-22T00:00:00.000Z",
          "children": []
        }
      ]
    }
  ]
}
```

## 模型接口

### 获取可用模型列表 `GET /api/v1/models`

说明：返回当前 Pi Runtime 可选模型列表。

成功响应：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `models` | `array` | 模型列表 |

模型对象字段由 `pi-client` 决定，至少用于前端展示 `label`、`provider`、`id` 等信息。

## 会话接口

### 获取会话详情 `GET /api/v1/sessions/:sessionId/info`

说明：聚合返回会话基础信息、所属项目、血缘、角色模板、提示词快照、同步状态、最近事件等。

成功响应示例：

```json
{
  "session": {
    "id": "session_xxx",
    "title": "Planner Session",
    "project_id": "project_xxx",
    "parent_session_id": null,
    "root_session_id": "session_xxx",
    "created_by": "local-user",
    "created_at": "2026-06-22T00:00:00.000Z",
    "archived_at": null,
    "pi_session_id": "pi_xxx",
    "pi_session_locator_json": "{...}",
    "status": "active",
    "runtime_status": "idle",
    "current_model": null
  },
  "project": {
    "id": "project_xxx",
    "name": "Info Project"
  },
  "lineage": {
    "parent_session": null,
    "root_session": {
      "id": "session_xxx",
      "title": "Planner Session"
    },
    "depth": 0
  },
  "role_template": {
    "key": "planner",
    "version": "1",
    "name": "Planner"
  },
  "prompts": {
    "role_base_prompt_snapshot": "...",
    "user_supplied_prompt": "...",
    "parent_supplied_prompt": null,
    "compiled_prompt": "..."
  },
  "sync": {
    "sync_status": "idle",
    "last_synced_at": null,
    "last_pi_message_id": null,
    "last_error": null,
    "retry_count": 0
  },
  "recent_events": []
}
```

### 获取会话消息历史 `GET /api/v1/sessions/:sessionId/chat/messages`

查询参数：

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `limit` | `number` | 否 | 分页大小，默认 `50`，最大 `100` |
| `cursor` | `string` | 否 | 分页游标，首次可不传或传 `0` |

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "cursor": null,
  "next_cursor": "cursor_xxx",
  "messages": [
    {
      "id": "msg_xxx",
      "role": "user",
      "message_kind": "normal",
      "source_session_id": null,
      "content_text": "hello",
      "created_at": "2026-06-22T00:00:00.000Z"
    }
  ]
}
```

### 发送会话消息 `POST /api/v1/sessions/:sessionId/chat/messages`

说明：写入用户消息并异步触发 LLM 运行。HTTP 返回为受理态，真实生成内容通过 `WebSocket chat_stream` 推送。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `content` | `string` | 是 | 用户发送的消息文本 |

请求示例：

```json
{
  "content": "hello realtime"
}
```

成功响应示例：

```json
{
  "accepted": true,
  "session_id": "session_xxx",
  "run_id": "run_xxx",
  "message_id": "message_xxx"
}
```

### 设置会话模型 `POST /api/v1/sessions/:sessionId/model`

说明：为指定会话切换模型。仅当会话 `runtime_status=idle` 时允许调用。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | `string` | 是 | 模型提供商 |
| `id` | `string` | 是 | 模型 ID |

请求示例：

```json
{
  "provider": "openai",
  "id": "gpt-4.1"
}
```

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "model": {
    "provider": "openai",
    "id": "gpt-4.1",
    "label": "OpenAI / GPT-4.1"
  }
}
```

### 停止会话运行 `POST /api/v1/sessions/:sessionId/stop`

说明：请求停止当前会话，并将运行状态置为 `stopping`。

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "status": "stopping"
}
```

### 归档会话 `POST /api/v1/sessions/:sessionId/archive`

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "status": "archived"
}
```

### 获取 Git Diff `GET /api/v1/sessions/:sessionId/git-diff`

说明：在会话所属项目目录执行 `git diff`，返回当前工作区差异。

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "diff": "diff --git a/...",
  "cwd": "/path/to/project"
}
```

### 更新会话标题 `PATCH /api/v1/sessions/:sessionId`

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | `string` | 是 | 新标题，长度需在 `1-200` 字符之间 |

请求示例：

```json
{
  "title": "Renamed Session"
}
```

成功响应示例：

```json
{
  "session_id": "session_xxx",
  "title": "Renamed Session",
  "title_source": "user"
}
```

## WebSocket 协议

### 连接入口

- 路径：`GET /ws`
- 协议：`WebSocket`
- 鉴权：
  - 优先读取 `Authorization: Bearer <token>`
  - 开发/测试环境可回退 `x-user-id`

连接建立后，服务端会立即发送：

```json
{
  "kind": "event",
  "type": "connection.opened",
  "timestamp": "2026-06-22T00:00:00.000Z",
  "payload": {
    "status": "ok"
  }
}
```

### 客户端消息

#### `hello`

```json
{
  "kind": "client",
  "type": "hello",
  "payload": {
    "user_agent": "web"
  }
}
```

服务端响应：`connection.hello`

#### `set_context`

说明：设置当前订阅上下文，用于接收指定项目或会话的实时消息。

```json
{
  "kind": "client",
  "type": "set_context",
  "payload": {
    "project_id": "project_xxx",
    "session_id": "session_xxx",
    "current_tab": "chat"
  }
}
```

`current_tab` 可选值：`chat`、`session_info`、`git_diff`

服务端响应：`context.updated`

#### `ping`

```json
{
  "kind": "client",
  "type": "ping",
  "payload": {
    "timestamp": "2026-06-22T00:00:00.000Z"
  }
}
```

服务端响应：`connection.pong`

### 服务端消息

#### 通用事件消息 `event`

结构：

```json
{
  "kind": "event",
  "type": "tree.changed",
  "timestamp": "2026-06-22T00:00:00.000Z",
  "scope": {
    "project_id": "project_xxx",
    "session_id": "session_xxx"
  },
  "payload": {}
}
```

当前代码中可见的事件类型包括：

| 事件类型 | 触发时机 | 典型 payload |
| --- | --- | --- |
| `connection.opened` | WebSocket 连接建立后 | `{ "status": "ok" }` |
| `connection.hello` | 收到客户端 `hello` 后 | `{ "user_agent": "web" }` |
| `context.updated` | 收到客户端 `set_context` 后 | 当前上下文对象 |
| `connection.pong` | 收到客户端 `ping` 后 | `{ "timestamp": "..." }` |
| `project.created` | 创建项目后 | `{ "project_id": "project_xxx" }` |
| `session.created` | 创建会话后 | `{ "session_id": "session_xxx" }` |
| `session.updated` | 会话更新后，例如改标题、发消息进入运行态 | `{ "session_id": "session_xxx" }` |
| `session.archived` | 会话归档后 | `{ "session_id": "session_xxx" }` |
| `session.runtime_status_changed` | 会话运行状态变化时 | `{ "runtime_status": "running" }`、`{ "runtime_status": "stopping" }`、`{ "runtime_status": "idle" }` |
| `tree.changed` | 项目树或会话树发生变化时 | `{ "project_id": "project_xxx" }` |

#### 聊天流式消息 `chat_stream`

说明：由会话消息发送触发，用于推送大模型生成过程。

结构：

```json
{
  "kind": "chat_stream",
  "phase": "delta",
  "timestamp": "2026-06-22T00:00:00.000Z",
  "scope": {
    "session_id": "session_xxx"
  },
  "payload": {
    "stream_id": "run_xxx",
    "message_id": "message_xxx",
    "delta": "partial text",
    "blocks": null,
    "error": null
  }
}
```

`phase` 可选值：

| phase | 说明 |
| --- | --- |
| `start` | 开始生成 |
| `delta` | 增量文本片段 |
| `complete` | 生成完成 |
| `error` | 生成失败 |

## 备注

- 当前项目是 `TypeScript` 后端，不是 `Go`，因此不适合直接接 `swaggo/swag`。
- 代码中可补充「Swagger 风格注释」作为过渡，但若未来要接 `Swagger UI`，更合适的方向是补 `OpenAPI` 生成或手写 `openapi.yaml`。
