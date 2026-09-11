# ask_question 通知能力设计（2026-09-11）

## 1. 需求

`ask_question`（agent 向用户提问）目前只在「用户正好处于该会话页」时可见。用户在其他会话/其他标签页时无法感知有待回答的问题，agent 会一直阻塞等待。

目标：ask_question 发起时主动通知用户；点击通知可跳回对应会话。

## 2. 现状核实（关键结论）

### 2.1 事件通路是断的（本次核心问题）

- `apps/api/src/routes/sessions/routes/ask-question.ts` 的 `onAskQuestionPending` 监听器调用
  `socketHub.sendToSession(sessionId, ask_question_pending 事件)`。
- `apps/api/src/ws/session.ts`：`sendToSession` **忽略 sessionId 参数**，投递由 `shouldDeliver()` 决定：
  带 `scope.session_id` 且不在 `GLOBAL_EVENT_TYPES` 白名单的事件，只投给**已订阅该会话的连接**。
  `ask_question_pending` 不在白名单内。
- `apps/web/src/lib/ws-provider.tsx` 的 `setSessionContext()` 在切会话时 `unsubscribeSession(prev)`，
  因此前端任何时刻最多只订阅 **1 个会话**。

结论：**用户不在提问所在会话时收不到 `ask_question_pending`**。
`askingPendingMap`、`Sidebar` 的琥珀灯（`Sidebar.tsx:153`）实际只对当前激活会话生效。
现有测试 `apps/api/src/routes/ask-question.test.ts:323` 断言「另一条未订阅连接收不到」，
正是这个缺陷的固化——本次需改为断言**跨用户**隔离。

### 2.2 已有可复用基建

| 能力 | 位置 |
| --- | --- |
| 系统通知发送 | `apps/web/src/lib/notification.ts`（Web Notification API，Electron 渲染进程同样可用） |
| 通知权限申请 + 总开关 UI | `apps/web/src/App.tsx`（localStorage `pi-system-notifications`）+ `SettingsPanel` |
| 全局 pending map / 订阅接口 / 清理 | `apps/web/src/lib/ws-provider.tsx`（`askingPendingMap`、`subscribeToAskQuestionPending`、`clearAskPending`） |
| 去重集合模式 | `ws-provider.tsx` 的 `notifiedRef`（idle / error 通知已用） |
| 侧边栏琥珀标记渲染 | `apps/web/src/components/Sidebar.tsx`（有渲染、无数据） |
| 会话树查找会话标题 | `apps/web/src/lib/tree-utils.ts` 的 `findSessionNode` |

桌面端（`apps/desktop`）主进程没有任何 `Notification` 调用；渲染进程的 Web Notification 在 Electron 中
可用，**本次无需改 desktop**。

## 3. 方案（用户已确认）

### 3.1 数据通路：后端按用户定向推送 + 前端补偿拉取

1. **`socketHub.sendToUser(userId, message)`**（`apps/api/src/ws/session.ts`）
   按连接上已有的 `__userId`（`ws/server.ts` 认证握手写入）定向投递，绕过订阅过滤但**仅限本人**。
   多用户部署下不泄露他人提问内容。
2. **ask-question 监听器改为按会话 owner 投递**（`ask-question.ts`）
   查 `sessions.createdBy` → `sendToUser(createdBy, event)`；
   查不到 owner（auth 关闭的历史数据）→ 回退 `broadcast`（本地单用户场景）。
3. **全局补偿接口 `GET /api/v1/ask-pending`**（`ask-question.ts` + `apps/api/src/app.ts` 挂 `requireAuth`）
   返回当前用户全部会话的待回答问题。前端在 **挂载 / WS 重连（onOpen）/ 窗口重新聚焦** 时拉取一次，
   补齐断线期间错过的事件（不做定时轮询）。
4. **domain 新增 `listAllPending()`**（`packages/domain/src/extensions/ask-question.ts`），
   与 `listPendingForSession` 共用 payload 构造。

### 3.2 通知形式（4 种并存）

| 形式 | 触发/可见性 | 说明 |
| --- | --- | --- |
| 系统通知（OS 弹窗） | 任意场景（受浏览器权限） | 复用 `sendSystemNotification` + 现有 `pi-system-notifications` 总开关，不新增设置；`silent: true`（用户未选声音，不播系统提示音） |
| 侧边栏会话项琥珀标记 | 应用内 | 数据通路修好后**全局生效**（已有渲染逻辑） |
| 应用内 toast | 应用内 | 新增 `AskQuestionNotifier` 渲染浮层，无需权限 |
| 标签页标题前缀 | 应用内（标签可见） | `(N 条待回答) PiPlus`，pending 清空后还原 |

声音提示：不实现（用户未选）。

### 3.3 触发条件

`shouldNotifyAsk({ sessionId, activeSessionId, hasFocus })`：
- 提问所在会话 **≠** 当前激活会话 → 通知
- 或 **窗口/标签页失焦**（`document.hasFocus()` / `visibilityState`）→ 通知
- 同一 `questionId` 在一次页面生命周期内只通知一次（去重）

### 3.4 点击行为

系统通知 `onclick` 与 toast 点击：`window.focus()` + `onNavigateSession(sessionId)`
→ App `handleSelectSession`（切换项目/会话/标签页，移动端收起侧边栏）。

## 4. 变更清单

### 后端
- `apps/api/src/ws/session.ts`：新增 `sendToUser`，抽出统一发送+清理辅助函数
- `apps/api/src/routes/sessions/routes/ask-question.ts`：监听器改定向投递；新增全局 `GET /api/v1/ask-pending`
- `apps/api/src/app.ts`：`/api/v1/ask-pending` 挂 `requireAuth`
- `packages/domain/src/extensions/ask-question.ts`：`listAllPending()`

### 前端
- `apps/web/src/lib/api.ts`：`getAllAskPending()`
- `apps/web/src/lib/ask-notify.ts`（新）：纯函数 `shouldNotifyAsk` / `askNotificationBody` / `withAskTitle` / `stripAskTitle`
- `apps/web/src/components/AskQuestionNotifier.tsx`（新）：订阅 pending → 系统通知 / toast / 标题前缀 / 点击跳转
- `apps/web/src/lib/ws-provider.tsx`：`reconcileAskPending()`（挂载 / onOpen / window focus / visibilitychange，in-flight 合并）+ 登出清空 `askingPendingMap`
- `apps/web/src/App.tsx`：渲染 `<AskQuestionNotifier>`，接 `handleSelectSession`

## 5. 测试

| 层 | 用例 |
| --- | --- |
| `apps/api/src/ws/session.test.ts` | `sendToUser` 只投给同 userId 连接；同用户未订阅连接也能收到；未订阅的**其他用户**收不到 |
| `apps/api/src/routes/ask-question.test.ts` | ① 同用户未订阅连接收到（更新原断言）；② 其他用户连接收不到；③ `GET /api/v1/ask-pending` 只返回本人会话 |
| `apps/web/src/lib/ask-notify.test.ts` | 触发条件矩阵；标题前缀生成/还原；通知正文（单题/问卷） |
| `apps/web/src/components/AskQuestionNotifier.test.tsx` | 非活跃会话收到事件 → 触发系统通知（含 `silent`）；活跃会话且聚焦 → 不通知；失焦 → 通知；点击通知/toast → `window.focus()` + `onNavigateSession`；toast 渲染与关闭；标题前缀随 pending 变化、卸载还原；权限被拒 → 降级为 toast |
| `apps/web/src/lib/ws-provider.test.tsx` | 补偿：挂载/重连时调用 `GET /api/v1/ask-pending` 并合并进 `askingPendingMap`；实时与补偿重叠去重；登出（4401）清空 map |

## 6. 平台差异

| 平台 | 系统通知 | 说明 |
| --- | --- | --- |
| Electron 桌面端 | 可用 | 渲染进程 Web Notification 经 OS 通知中心展示；点击回调在渲染进程执行 |
| 浏览器 HTTPS / localhost | 可用 | 需用户授权（现有设置面板已处理） |
| 浏览器 HTTP（非 localhost） | 不可用 | `Notification` API 被浏览器禁用；仍可用 toast / 侧边栏 / 标题前缀 |
| 权限被拒 | 不可用 | `sendSystemNotification` 返回 false，静默降级为应用内提示 |

## 7. 已知限制（有意为之）

1. **补偿是「合并」不是「全量对账」**：`GET /api/v1/ask-pending` 只用于补齐本地缺失的 questionId，
   不会移除本地多出来的条目。原因：答题会在服务端立即从 pending 表移除，若补偿时删本地条目，
   会让 TabChat 「已提交」占位在工具结果到达前就消失。
   代价：多标签页场景下，在 A 标签页回答后，B 标签页的琥珀灯/标题前缀会保留到 B 刷新或切回该会话
   （TabChat 检测到 tool result 后调用 `clearAskPending`）。
2. **不做定时轮询**：只有挂载、WS 重连、窗口聚焦、标签页重新可见四个时机各拉一次；
   若提问在「连接断开且页面一直处于后台」期间产生，需要用户回到页面才会补到（此时会通知）。
