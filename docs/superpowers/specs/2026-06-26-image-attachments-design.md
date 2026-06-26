# 前端图片附件输入与 Pi SDK 多模态发送设计

**日期：** 2026-06-26  
**范围：** `apps/web`, `apps/api`, `packages/pi-client`, `packages/shared`, `packages/db`

## 1. 目标

为当前 Web 聊天界面增加图片附件输入能力，支持：
- 选择本地图片文件
- 从剪贴板粘贴图片
- 单条消息最多附带 4 张图片
- 仅当当前会话模型支持图片输入时允许发送
- 通过 Pi SDK 原生 `session.prompt(text, { images })` 将图片发送给支持图片的模型
- 在聊天历史中回显用户消息图片缩略图，并支持查看原图

本次不包含：
- 拖拽上传
- 非图片文件附件
- assistant 输出图片渲染
- 图片编辑、裁剪、压缩参数配置

## 2. 现状总结

### 前端
- `apps/web/src/components/TabChat.tsx` 当前仅支持纯文本输入。
- `apps/web/src/lib/api.ts` 中 `sendSessionMessage(sessionId, content)` 仅发送 `{ content }`。
- `apps/web/src/lib/hooks.ts` 中 `useSendMessageMutation()` 也仅接受字符串。
- 前端已经知道模型能力：模型配置中存在 `input: ['text', 'image']`。

### 后端
- `apps/api/src/routes/sessions.ts` 的 `POST /api/v1/sessions/:sessionId/chat/messages` 目前只读取 `content`，为空时返回 `EMPTY_MESSAGE`。
- 当前发送流程会把用户消息写入 `messages` 表，并调用 `startSessionRun()` 开始 Pi 会话执行。
- `messages` 表已有 `content_blocks_json` 字段，可用于保存结构化内容。

### Pi SDK / pi-client
- `packages/pi-client/src/client.ts` 当前 `sendMessage(sessionId, content)` 调用 `session.agentSession.prompt(content)`。
- Pi SDK 文档明确支持 `session.prompt(text, { images })`。
- Pi session 文件格式支持 user message 的 `content` 为 `string | (TextContent | ImageContent)[]`。

### 历史读取
- `packages/pi-client/src/history.ts` 当前会把 user message 只还原成纯文本，忽略 image block。
- `apps/api/src/routes/sessions.ts` 的消息历史接口当前也只返回 `content_text` 与工具相关字段。

## 3. 用户确认的产品决策

- 输入方式：同时支持本地文件选择与剪贴板粘贴
- 历史回显：显示缩略图，可再次查看原图
- 数量限制：每条消息最多 4 张图片
- 不支持图片的模型：禁止发送，并提示切换到支持图片的模型

## 4. 方案选择

采用**方案 1：前后端统一走结构化消息块**。

### 核心原因
1. 与 Pi SDK 原生多模态接口一致，不需要把图片降级为文本描述或临时文件引用。
2. 与 session 文件格式一致，后续历史解析、分支、恢复、导出更自然。
3. 与现有数据库字段 `content_blocks_json` 一致，避免临时旁路存储。
4. 后续若要增加更多输入块（如音频、文档引用）可以沿用同一结构扩展。

## 5. 数据模型设计

### 5.1 共享消息块类型

在 `packages/shared` 中新增或扩展聊天消息块类型，至少包含：

- `text` 块
  - `type: 'text'`
  - `text: string`
- `image` 块
  - `type: 'image'`
  - `mime_type: string`
  - `data_base64: string`
  - `width?: number`
  - `height?: number`
  - `filename?: string | null`

说明：
- 首版保留 `data_base64` 直接透传，避免引入额外对象存储。
- `width/height` 为可选元数据，前端如能方便获取则带上；不能获取也不阻塞。
- `filename` 对文件选择场景有帮助；粘贴图可为空。

### 5.2 发送请求结构

`POST /api/v1/sessions/:sessionId/chat/messages` 请求体扩展为：

```json
{
  "content": "请描述这些图片",
  "attachments": [
    {
      "type": "image",
      "mime_type": "image/png",
      "data_base64": "...",
      "filename": "screenshot.png"
    }
  ]
}
```

约束：
- `content` 可为空字符串，但如果为空则必须至少有 1 张图片。
- `attachments` 可省略。
- `attachments.length <= 4`。
- 仅允许图片 MIME：`image/png`、`image/jpeg`、`image/webp`、`image/gif`。

### 5.3 历史消息结构

扩展 `ChatMessageDTO`，在保留 `content_text` 的同时增加可选结构化字段：
- `content_blocks?: ChatMessageContentBlockDTO[] | null`

保留 `content_text` 的原因：
- 不破坏现有文本渲染逻辑
- assistant/tool/tool_call 仍然主要依赖文本字段
- 便于兼容历史旧数据

对于带图片的用户消息：
- `content_text` 继续保存文本部分（可能为空）
- `content_blocks` 用于前端渲染缩略图

## 6. 发送链路设计

### 6.1 前端输入行为

在 `TabChat` 中增加：
- 文件选择按钮：仅接受图片 MIME
- 粘贴监听：当 textarea 聚焦或输入区域激活时，识别剪贴板中的图片项
- 附件预览条：展示最多 4 张图的缩略图与删除按钮
- 发送前校验：
  - 当前模型不支持 `image` → 禁止发送并提示
  - 超过 4 张 → 拒绝继续添加并提示
  - 既没有文本也没有图片 → 不发送

### 6.2 前端 API 调用

`sendSessionMessage()` 从仅接受 `content: string` 扩展为接受：
- `content: string`
- `attachments?: ImageAttachmentInput[]`

`useSendMessageMutation()` 同步改为接受对象载荷。

### 6.3 API 校验与落库

`sessions.ts` 中发送接口扩展：
- 解析并校验 `attachments`
- 如果模型不支持图片且请求包含图片，返回 400（新增明确错误码）
- 构造统一 `contentBlocks`：
  - 文本存在时加入 `text` block
  - 每张附件加入 `image` block
- DB 写入：
  - `contentText` = 文本内容（可为空字符串）
  - `contentBlocksJson` = `contentBlocks` 的 JSON
  - `contentVersion` 更新为本次结构版本

即使文本为空，只要有图片也允许入库和发送。

### 6.4 Pi SDK 转换

`packages/pi-client` 扩展 `sendMessage()` 签名，接收：
- `content: string`
- `images?: PiImageInput[]`

发送时：
- 无图：保持 `session.prompt(content)` 或 `session.prompt(content, undefined)`
- 有图：调用 `session.prompt(content, { images })`

图片映射到 Pi SDK `ImageContent[]`：
- `type: 'image'`
- `source: { type: 'base64', mediaType, data }`

若文本为空，仍允许发送空字符串配合 `images`。

## 7. 历史回显设计

### 7.1 历史解析来源

采用 Pi session 文件作为主历史来源，避免单独依赖本地 DB 形成双真相。

`packages/pi-client/src/history.ts` 需要：
- 解析 user message 的 `content` 数组
- 保留文本块与图片块
- 返回给 API 层结构化内容

这样可以保证：
- 会话恢复后历史一致
- 分支/fork 后历史仍完整
- 与真实送入模型的内容一致

### 7.2 API 响应

历史接口把 `PiHistoryMessage` 映射为 `ChatMessageDTO` 时：
- 继续输出 `content_text`
- 新增 `content_blocks`

对于不含图片的历史记录，`content_blocks` 可以为 `null` 或省略。

### 7.3 前端渲染

`TabChat` 中：
- 用户消息若存在图片块，在文本气泡上方或下方显示缩略图列表
- 点击缩略图弹出原图预览（可复用现有 `Modal` 组件）
- assistant / tool 消息保持现状，不新增图片渲染逻辑

UI 目标：
- 不破坏当前文本为主的对话布局
- 缩略图尺寸统一，支持深色模式
- 附件删除、预览、发送状态保持清晰

## 8. 模型能力约束

### 前端
- 根据当前会话已选模型能力判断是否支持图片输入
- 如果不支持图片：
  - 附件按钮可禁用或允许选择后在发送时阻止
  - 明确提示“当前模型不支持图片输入，请切换到支持 image 的模型”

### 后端
- 不能只信任前端
- 在发送前根据 session 当前模型再次校验支持能力
- 若不支持则返回显式错误，例如：
  - `MODEL_DOES_NOT_SUPPORT_IMAGES`

双层校验可避免：
- 旧前端调用新 API
- 前端状态滞后
- 恶意请求绕过 UI 限制

## 9. 错误处理

需要覆盖以下错误：
- 空消息且无图片
- 图片数量超过 4 张
- MIME 不支持
- base64 非法或为空
- 当前模型不支持图片输入
- 请求体过大（由运行环境或后续限制处理）

首版暂不单独引入高级压缩/缩放逻辑；若 Pi SDK 或上游模型侧有限制，先依赖现有运行时错误返回。

## 10. 测试设计

### API 测试
- 发送纯文本仍兼容通过
- 发送“文本 + 单张图片”返回 202
- 发送“仅图片无文本”返回 202
- 超过 4 张图片返回 400
- 不支持图片模型发送图片返回 400
- 历史接口返回 `content_blocks`，其中包含 image block

### pi-client 测试
- `sendMessage()` 无图时保持旧行为
- `sendMessage()` 有图时使用 `prompt(text, { images })`
- `history.ts` 能从 user message content 中解析图片块

### Web 测试
- API 参数构造正确
- 支持从输入区粘贴图片
- 选择文件后展示缩略图
- 删除附件后不再发送
- 当前模型不支持图片时阻止发送

## 11. 兼容性与迁移

- 不新增数据库迁移：`messages.content_blocks_json` 已存在
- 旧消息没有 `content_blocks_json` 或 session 文件中无 image block 时，前端仍按纯文本渲染
- 旧前端继续发 `{ content }` 时，新后端仍兼容

## 12. 实现边界

本次不做：
- 拖拽上传
- 图片排序拖动
- 图片压缩策略面板
- 图片 EXIF 处理
- assistant/tool 图片渲染
- 独立媒体存储层

## 13. 风险与应对

### 风险 1：base64 载荷较大
- 首版接受该成本，因为范围仅限最多 4 张图片
- 后续如遇明显瓶颈，再演进为上传层或压缩策略

### 风险 2：历史来源不一致
- 通过优先解析 Pi session 文件规避
- API 落库仍保存 `content_blocks_json` 作为本地镜像，而不是唯一来源

### 风险 3：模型能力来源不完整
- 当前系统已经维护模型 `input` 能力字段
- 前端与后端都依赖同一能力语义：`input.includes('image')`

## 14. 设计结论

本设计采用统一消息块模型，把图片作为用户消息的结构化内容贯穿：
- 前端输入与预览
- API 校验与入库
- `pi-client` → Pi SDK 多模态发送
- 历史解析与缩略图回显

该方案满足当前范围，且为未来扩展更多输入类型留下统一接口。