# 拆分巨型文件实现计划（sessions.ts + pi-client/client.ts）

> **For agentic workers:** 本计划由 feature_lead 委派 worker 执行。纯结构重构、零行为变更，不适用 TDD（现有测试即回归防线）。

**Goal:** 将 `apps/api/src/routes/sessions.ts`（2054 行）与 `packages/pi-client/src/client.ts`（1204 行）按职责拆分为子模块，对外行为与导出完全不变。

**Architecture:** 方案 A——目录化拆分 + 原文件变薄壳。所有代码**逐字搬运**，仅调整 import/export；鉴权调用与 WS 推送调用点原样保留。

**Tech Stack:** Bun monorepo，Hono 后端，TypeScript strict。

---

## 全局硬约束（两个 worker 都必须遵守）

1. 【严禁改动】`apps/api/src/ws/**`、pi-stream-bridge 相关文件、`packages/shared` 的 WS 协议类型、auth 中间件 / `requireAuth` / HMAC 相关代码。
2. 【严禁改动】任何 `package.json` 与 `bun.lock`。
3. 纯重构：HTTP API 路径/方法/响应、WS 协议、模块导出行为完全不变。
4. 代码搬运必须逐字复制，不改逻辑、不改字符串、不改错误信息；只允许新增 import/export 语句和调整被移动声明的可见性（如需跨文件访问而加 `export`）。
5. 遇到"必须改动逻辑才能拆分"的冲突点：停止并报告，不要自行改逻辑。
6. 工作目录：worktree 根 `/home/bighu/server/piplus/.worktrees/refactor-split-giants`。
7. 完成标准：`cd apps/api && bun test`（108 pass / 1 fail 存量 CORS 失败不变）、`cd packages/pi-client && bun test`（23 pass）、`bun run typecheck` 通过。

## Task 1: 拆分 apps/api/src/routes/sessions.ts

目标结构（`routes/sessions.ts` 变薄壳 re-export）：

```
apps/api/src/routes/sessions.ts          ← 仅 re-export：registerSessionRoutes、registerSessionMutationRoutes、
                                            parseModelRef、stripMergedPromptPrefix、describeImagesWithFallback、
                                            buildVisionMergedContent（以现有外部实际引用为准，先 grep 确认）
apps/api/src/routes/sessions/
  shared.ts                              ← randomId、encodeCursor/decodeCursor/MessageCursor、nextMessageTime、
                                            MAX_* / ALLOWED_IMAGE_MIME_TYPES / IMAGE_MIME_MAP 等通用常量
  model-capabilities.ts                  ← getPiplusModelsFilePath、getPiModelsFilePath、readModelCapabilities(FromFile)、
                                            resolveSessionModelWithCapabilities、modelSupportsImageInput
  vision.ts                              ← VISION_* 常量、normalizeImageAttachments、parseImageAttachments、
                                            parseModelRef、modelRefLabel、describeImagesWithModel、
                                            describeImagesWithFallback、buildVisionMergedContent、
                                            parseStoredContentBlocks、insertVisionFailureMessage、
                                            stripMergedPromptPrefix
  file-tree.ts                           ← buildFileTree、isTextFilePath、looksLikeBinary、TEXT_FILE_EXTENSIONS、
                                            IGNORED_ENTRY_NAMES、MAX_FILE_TREE_DEPTH/MAX_FILE_CONTENT_BYTES/MAX_FILE_WRITE_BYTES
  routes/index.ts                        ← registerSessionRoutes：组装下列各注册函数（保持原路由注册顺序）
  routes/chat.ts                         ← info、planner-role-prompt、chat/messages GET+POST 的 handler 注册
  routes/model-config.ts                 ← POST /model、GET+PUT /thinking-level
  routes/files.ts                        ← files/tree、files/content GET+PUT+DELETE、files/image
  routes/git.ts                          ← git-diff、git/pull|push|commit|gitignore|branches|commits|show|checkout
  routes/runtime.ts                      ← stop、archive、context-usage、compact、restore-runtime、commands
  routes/mutation.ts                     ← registerSessionMutationRoutes（PATCH /api/v1/sessions/:sessionId）
```

要点：
- `registerSessionRoutes(app, piClient)` 内的局部状态（如有闭包共享变量）必须保持在同一闭包作用域链中可达——若局部状态被多个 handler 共享，将其作为参数传入各子注册函数，不改语义。
- 子注册函数签名建议 `(app: Hono, ctx: SessionRouteDeps)` 形式，deps 含 piClient 及共享 helper 引用；以最小接口为准。
- 保持所有路由的注册顺序（Hono 匹配顺序语义）。
- 验证：`cd apps/api && bun test` 结果与基线一致；`bun run typecheck` 无新错误。
- 提交：`git commit -m "refactor(api): split routes/sessions.ts into sessions/ modules"`

## Task 2: 拆分 packages/pi-client/src/client.ts

关键约束：`client.ts` 第 32-34 行的模块级初始化（`runtimeRegistry`、`await ModelRuntime.create()`、`modelRegistry`）**必须留在 client.ts 原位置**，保持 top-level await 初始化顺序。子模块通过显式参数接收 `{ runtimeRegistry, modelRuntime, modelRegistry }`（或最小所需子集），不得把 await 移入子模块。

目标结构：

```
packages/pi-client/src/client.ts         ← 保留：模块级单例初始化 + createPiClient() 骨架，
                                            各方法体委托到 client/ 子模块函数
packages/pi-client/src/client/
  event-mapping.ts                       ← mapAgentSessionEvent 及其辅助
  commands.ts                            ← BUILTIN_COMMANDS、isSlashCommandMessage、parseSlashCommand、
                                            executeBuiltinCommand、collectCommands
  session-lifecycle.ts                   ← createSession、restoreRuntime、ensureRuntime（运行时生命周期部分）、
                                            disposeSession、closeRuntime、sessionFileHasModelChange
  messaging.ts                           ← sendMessage、stopSession、subscribeSession、injectPromptIfNeeded、getHistory、
                                            normalizeImages
  tools.ts                               ← bindToolRuntime、registerTools
  model-config.ts                        ← listAvailableModels、getCurrentModel、completeModel、buildCompleteModelContext、
                                            setSessionModel、getThinkingLevel、getAvailableThinkingLevels、setThinkingLevel
  context.ts                             ← getContextUsage、compactSession
  providers.ts                           ← reloadIdleRuntimes、registerProvider、setProviderApiKey、removeProviderApiKey、
                                            getProviderAuthStatus
```

- `PiClient` 接口（types.ts）不动；createPiClient 返回对象形状与方法顺序不变（方法体一行委托）。
- `index.ts` 导出不变；测试只从主入口导入，无需改动测试。
- 验证：`cd packages/pi-client && bun test` 23 pass；typecheck 通过。
- 提交：`git commit -m "refactor(pi-client): modularize client.ts into client/ submodules"`

## Task 3: 整合验证

- worktree 根跑全量 `bun run typecheck` 与两包测试，确认基线一致。
- 顺手发现的小问题写入报告文件 `docs/superpowers/plans/2026-08-23-split-giant-files-findings.md`，不混入重构 commit。
