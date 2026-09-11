# TODO: ask_question 通知能力

方案：`docs/superpowers/specs/2026-09-11-ask-question-notify-design.md`（已含已知限制）

## 后端（数据通路）
- [x] domain：`listAllPending()`（与 `listPendingForSession` / `createPending` 共用 `buildPendingPayload`）
- [x] hub：`socketHub.sendToUser(userId, message)`
- [x] 路由：监听器改 `sendToUser(owner)`，无 owner 回退 `broadcast`
- [x] 路由：`GET /api/v1/ask-pending`（本人全部会话）+ `app.ts` 挂 `requireAuth`
- [x] 测试：`ws/session.test.ts` sendToUser 隔离；`routes/ask-question.test.ts` 更新 WS 断言 + 全局接口

## 前端（通知链路）
- [x] `lib/api.ts`：`getAllAskPending()`
- [x] `lib/ask-notify.ts`：`shouldNotifyAsk` / `isWindowFocused` / `askNotificationBody` / `withAskTitle` / `stripAskTitle`
- [x] `components/AskQuestionNotifier.tsx`：系统通知 + toast + 标题前缀 + 点击跳转
- [x] `lib/ws-provider.tsx`：`publishAskPending` / `reconcileAskPending`（挂载 / onOpen / focus / visibilitychange，in-flight 合并）
- [x] `lib/notification.ts`：`createSystemNotification`（可绑 onclick）+ 开关读取统一
- [x] `App.tsx`：渲染 `<AskQuestionNotifier>`，接 `handleSelectSession`
- [x] 测试：`ask-notify.test.ts`（16）、`AskQuestionNotifier.test.tsx`（11）、`ws-provider.test.tsx` 补偿用例（+2）

## 验证（scoped，遵守 AGENTS.md）
- [x] `cd packages/domain && bun test` → 122 pass
- [x] `cd packages/shared && bun test` → 4 pass
- [x] `cd apps/api && bun test` → 213 pass
- [x] `cd apps/web && bun test` → 149 pass
- [x] `cd apps/api && bun run typecheck` → 通过
- [x] `cd packages/domain && bun run typecheck` → 通过
- [x] `cd apps/web && bun run lint` → 通过

## 审查
- [ ] reviewer 审查 → 修复 → 复审直到通过
