# pi session runtime 回收机制调查报告

## 修复状态

8 项问题已全部在 worktree（分支 `fix/runtime-reclamation`）修复，全部测试与 typecheck 通过。

| # | 严重度 | 修复 | 实现说明 |
|---|---|---|---|
| 1 | 高 | ✅ 已修复 | `ensureRuntime` early-return 路径重置 client 定时器；`closeRuntime` 加 isStreaming 守卫，流式生成中跳过回收并 30s 后重试（client.ts） |
| 2 | 中 | ✅ 已修复 | `reloadIdleRuntimes` dispose 后置空 `agentSession` 并清理 timer/listeners/tools/messages（client.ts） |
| 3 | 中 | ✅ 已修复 | `sendMessage` agentSession 分支顶部复位 `session.stopped = false`（client.ts） |
| 4 | 中 | ✅ 已修复 | 新增 `PiClient.disposeSession`；projects.ts 删除路由与 sessions.ts 归档路由主动清定时器并释放 runtime（types.ts + client.ts + projects.ts + sessions.ts） |
| 5 | 低 | ✅ 已修复 | `ensureRuntime` prompt 迁移后删除 piSessionId 别名 entry（client.ts） |
| 6 | 低 | ✅ 已修复 | `startSessionRun` busy 读检查改为原子条件认领（idle→running），认领后失败复位 idle；chat 路由把 session_busy 映射为 409（runtime.ts + sessions.ts） |
| 7 | 低 | ✅ 已修复 | `getRuntimeState` 增加 isStreaming；`startSessionRun` 检测到 isStreaming 时重新武装回收定时器并抛 session_busy（runtime-registry.ts + types.ts + runtime.ts） |
| 8 | 低 | ✅ 已修复 | 新建 `packages/pi-client/src/constants.ts` 导出 `NON_WORKER_IDLE_RUNTIME_TTL_MS`（PIPLUS_IDLE_RUNTIME_TTL_MS 可覆盖），domain 与 client 双定时器统一取值 |

> 调查范围：packages/domain/src/session/runtime.ts、packages/pi-client/src/{client.ts,runtime-registry.ts}、apps/api/src（routes/sessions.ts、routes/projects.ts、routes/packages.ts、db-context.ts、index.ts）、packages/domain/src/extensions/role-manager-tools.ts、role-catalog.ts、packages/db/src/schema.ts

---

## 1. 架构总览：两套"定时器 + 状态"

runtime 生命周期由 **两个层级的 30 分钟定时器** 共同管理，外加 DB 中的 `sessions.runtimeStatus`（`idle`/`running`/`stopping`，schema.ts:62）作为状态机。

| 层级 | 文件 | 定时器 | 载体 |
|---|---|---|---|
| Domain 层（主） | `packages/domain/src/session/runtime.ts` | `idleRuntimeCleanupTimers: Map<sessionId, timeout>`（L11），每次 run 结束调度、每次 run 开始清除 | 模块级 Map |
| Client 层（辅） | `packages/pi-client/src/client.ts` | `session.idleCleanupTimer` 挂在 `RuntimeRegistry` 的 entry 上（runtime-registry.ts:33），runtime 创建/重建时设置 | 每个 runtime entry |

---

## 2. Runtime 的创建与生命周期

### 2.1 单例注册表
- `packages/pi-client/src/client.ts:25-26`：模块级单例 `runtimeRegistry = new RuntimeRegistry()`、`modelRuntime`、`modelRegistry`。API 进程单实例，所有请求共享（多窗口共用）。
- `RuntimeRegistry`（runtime-registry.ts:37-70）：`Map<sessionId, ActiveSessionRuntime>`，**无引用计数，一个 session 一个 entry**，entry 保留 `locator / cwd / model / prompt / listeners / idleCleanupTimer` 等。

### 2.2 创建时机（三种入口）
1. **`createSession`**（client.ts:~300）：新建会话时在 `piSessionId`（pi SDK 的 session id）下创建 entry，仅存 `prompt` + `model` 元数据，随即 `session.dispose()`。**这个 piSessionId entry 会一直留在内存里**（见问题 5.3）。
2. **`ensureRuntime(sessionId, {locator, cwd, tools, toolHandler})`**（client.ts:430-556）：每次 `startSessionRun` 的必经入口。若 entry 已有活的 `agentSession` 且 tools/handler 未变 → 直接返回（L444-448）；tools 变了 → dispose + 重建（L438-443）；否则 `SessionManager.open(sessionFile)` 读历史 → `createAgentSession` → 挂到 entry（L452-540）。**创建后设置 30 分钟 client 定时器（L547-551）**。会从 `piSessionId` entry 迁移 prompt（L514-522）。
3. **`restoreRuntime`**（client.ts:345-428，标 @deprecated）：不带 tools，只从 session 文件恢复 agentSession；被 `/api/v1/sessions/:sessionId/restore-runtime` 路由（sessions.ts:1787-1802）、`setSessionModel`/`getThinkingLevel`/`setThinkingLevel`/`compactSession` 在 runtime 缺失时调用。同样设置 client 定时器（L421-425）。

### 2.3 状态机（DB `sessions.runtimeStatus`）
- `idle`：初始/回收后（schema.ts:62 默认值）。
- `running`：`markSessionRunning`（runtime.ts:83-91）在 `startSessionRun` 内 L335 写入（注意：在 ensureRuntime 之后才写）。
- `stopping`：用户点停止 → `/stop` 路由（sessions.ts:963-977）先 `piClient.stopSession`（abort 后台执行）再置 `stopping`。之后由该 run 的 `doCleanup` 或 safety timeout 兜底转回 `idle`。

### 2.4 一次完整 run（startSessionRun，runtime.ts:104-424）
1. L116：`clearIdleRuntimeCleanup`（取消 domain 级回收定时器）
2. L129：读 DB 检查 `running/stopping` → 抛 `session_busy`
3. L150：`ensureRuntime`（无则创建/恢复 runtime）
4. L335：`markSessionRunning`
5. L356-367：订阅流事件（`subscribeSession`），每个事件 `resetTimeout`
6. L286-331：10 分钟 safety timeout（`PIPLUS_SESSION_TIMEOUT_MS` 可覆盖，L107-112），子会话运行中 / 跨项目等待中豁免
7. L374-424：`attemptSend` → `sendMessage`；首条消息模型失败时按 `candidateModels` 逐个 fallback 重试；完成后 `doCleanup()`

---

## 3. 回收机制（核心）

### 3.1 Domain 层：scheduleIdleRuntimeCleanup（runtime.ts:21-30）
```ts
const NON_WORKER_IDLE_RUNTIME_TTL_MS = 30 * 60 * 1000;   // L9
scheduleIdleRuntimeCleanup(piClient, sessionId, ttlMs) {
  clearIdleRuntimeCleanup(sessionId);                     // 先清旧
  setTimeout(() => {
    piClient.closeRuntime(sessionId).catch(...);          // 30 分钟后回收
    idleRuntimeCleanupTimers.delete(sessionId);
  }, ttlMs);
}
```
- 每次 run 开始（L116）与 worker 分支（L272）调用 `clearIdleRuntimeCleanup`。
- **每次 run 结束（doCleanup）都会重新调度** → 这是"活动重置"的正统机制。

### 3.2 doCleanup（runtime.ts:231-284）— run 结束的统一收尾
1. `cleanupDone` 防重入（L232）
2. 清 safety timeout（L235-239）
3. 有 error 时后台 `piClient.stopSession`（abort，L250-256）
4. 非 safety-timeout 错误写入 `sessionEvents`（`chat_runtime_error`，L257）
5. `clearRequestContext` / `clearCrossProjectWait`（L258-259）
6. `markSessionIdle`（L260）
7. `unsubscribe()`（L266）
8. **角色分流（L270-279）**：
   - `roleKey === 'worker'`：`clearIdleRuntimeCleanup` + **立即 `closeRuntime`**（L272-275）
   - 非 worker：`scheduleIdleRuntimeCleanup(piClient, sessionId)`（L278）→ 30 分钟后回收

### 3.3 Client 层：closeRuntime（client.ts:684-698）
```ts
async closeRuntime(sessionId) {
  const session = runtimeRegistry.get(sessionId);
  if (!session) return;                                  // 幂等
  if (session.idleCleanupTimer) clearTimeout(...);       // 清 client 定时器
  session.agentSession?.dispose();                       // AgentSession.dispose():
                                                         //   abortRetry/abortCompaction/abortBash/agent.abort()
                                                         //   extension runner invalidate + 断开订阅 + cleanupSessionResources
  session.agentSession = undefined;
  session.listeners.clear();
  session.toolHandler = undefined;
  session.toolDefs = [];
  session.messages = [];
  // 保留 registry entry（locator/cwd/model/prompt）→ 之后可 restoreRuntime 找回
}
```
**注意**：`AgentSession.dispose()`（node_modules/.../core/agent-session.js:556-571）会 `agent.abort()` 中断在途生成 —— 无 `isStreaming` 守卫。

### 3.4 其他回收入口
- **`reloadIdleRuntimes`**（client.ts:708-725，包启用/停用后由 packages.ts:241 调用）：`runtimeRegistry.closeIdle()`（runtime-registry.ts:90-102）—— 但 **只回收 `stopped === true` 且 `agentSession` 存在的 entry**，且 **dispose 后不置空 `agentSession`**（问题 5.4）。
- **`reloadProjectSessionRuntimes`**（runtime.ts:436-493，角色配置变更后由 projects.ts:718 调用）：对 idle 会话 `ensureRuntime` 重建（tools 变了 → 重建），running 跳过。不是回收，是刷新。
- **API 进程退出**：无任何优雅关闭逻辑（index.ts 只有 `Bun.serve`），进程退出直接释放；启动时 `recoverStuckSessions()`（db-context.ts:15-27，index.ts:12）把 DB 中所有非 idle 会话重置为 `idle` 并标记 `lastRuntimeError='recovered_after_restart'`。
- **项目/会话删除**：`DELETE /api/v1/projects/:projectId`（projects.ts:725-750）只删 DB 行（messages/sessionEvents/sessionSyncStates/sessions/projects），**不调用 closeRuntime**；归档路由（sessions.ts:992-1008）同样不碰 runtime。靠遗留的 30 分钟 domain 定时器兜底回收（若进程存活），进程重启则整体释放。

---

## 4. 回收触发时机汇总

| 场景 | 何时回收 | 路径 |
|---|---|---|
| 非 worker 会话 idle | 最后一次 run 结束后 **30 分钟** | doCleanup → scheduleIdleRuntimeCleanup（每次 run 重置） |
| worker 会话 | **run 结束立即**（成功/失败都回收） | doCleanup L272-275 |
| 10 分钟 safety timeout | timeout 触发 doCleanup → 再 30 分钟 | L286-331 → L231 |
| 用户停止 | 立即 abort；状态由 doCleanup 收尾转 idle，再 30 分钟回收 | /stop 路由 → stopSession → doCleanup |
| 进程退出/重启 | 立即（内存释放）；DB 由 recoverStuckSessions 复位 | index.ts:12 |
| 包启用/停用 | 仅 `stopped` 的会话被 dispose | packages.ts:241 |
| 项目/会话删除 | 不主动回收，等 30 分钟定时器（或进程重启） | projects.ts:725 |

**两个 30 分钟定时器的关系**：
- Domain 定时器：每次 run 完成调度、run 开始清除 → 与活动严格同步（正确）。
- Client 定时器：**只在 runtime 创建/重建时设置，活动不重置**（ensureRuntime 的 early-return 路径 L444-448 跳过刷新）。见问题 5.1。

---

## 5. 回收后的状态与重建

1. **DB 侧**：session 保持 `idle`，`lastActivityAt`/消息/事件全部保留；`lastRuntimeError` 记录最近错误（L95-100）。
2. **Client 侧**：registry entry 保留（locator、cwd、model、prompt），`agentSession` 置 undefined。
3. **重建**：再次发送消息 → API 路由 → `startSessionRun` → `ensureRuntime` → entry 在但 `agentSession` 为空 → `SessionManager.open(sessionFile)` → `buildSessionContext()` **读回完整历史**（messages/model_change/compaction 全部在 session 文件里）→ 新 AgentSession 上下文完整保留。
4. `isFirstConversation` 靠 `hasHistory`（runtime-registry.ts:79-88）读 session 文件判断；首条消息才做 prompt 合并（runtime.ts:190-205）。
5. worker 重建：spawn_session（role-manager-tools.ts:193，默认 'worker'）→ `startChildSessionRun`（L456-493）→ startSessionRun → ensureRuntime 重建 → run 完再次立即回收。

---

## 6. 潜在问题（按严重度排序）

### 6.1 [高] Client 层 idleCleanupTimer 不随活动刷新，可能中断在途 run
- ensureRuntime early-return（client.ts:444-448）**不重置** `session.idleCleanupTimer`；startSessionRun 只清 domain 定时器。
- 场景：runtime 在 T0 创建 → 持续使用（domain 定时器每次重置，runtime 一直存活）→ T0+30min client 定时器触发 → `closeRuntime` → `agentSession.dispose()` → **abort 正在生成的 agent**。
- 若命中 run 中：`sendMessage` 的 prompt 抛错/中断 → 错误展示给用户；若恰好 idle：无害（提前回收）。
- 修复建议：ensureRuntime early-return 时也应 `clearTimeout + 重新 setTimeout`（与 domain 定时器对齐），或在 closeRuntime 中加 `isStreaming` 守卫。

### 6.2 [中] reloadIdleRuntimes dispose 后未置空 agentSession → 死引用
- closeIdle（runtime-registry.ts:90-102）dispose 了 agentSession 但 entry 仍保留该引用（client.ts:708-725 的 dispose 回调不置空）。
- 后续 `ensureRuntime` 看到 `existing.agentSession` 为真（已 dispose）且 tools 未变 → early-return → `sendMessage` 对已 dispose 的 session 调 `prompt()`（extension runner 已 invalidate → 抛错）→ **每次消息都失败**，直到 30 分钟后 domain 定时器 closeRuntime 或 tools 变更才自愈。
- 触发条件：会话曾被停止（`stopped=true` 永不复位，见 6.3）→ 用户再切包 → 再发消息。会话会"卡"一段时间的错误态。

### 6.3 [中] `session.stopped` 永不复位
- `stopSession`（client.ts:672-683）置 `stopped=true`；只有 sendMessage 的 stub 分支（L640）会复位。正常路径永不复位。
- 后果：a) 一次停止后，该会话的 runtime 会被 `reloadIdleRuntimes` 误判为"可回收"（名字是 idle 实际按 stopped 过滤）；b) 配合 6.2 形成卡死窗口。

### 6.4 [中] 项目/会话删除不主动回收 runtime
- `DELETE /api/v1/projects/:projectId`（projects.ts:725-750）、archive（sessions.ts:992-1008）只删/改 DB，不 `closeRuntime`、不 `clearIdleRuntimeCleanup`。
- 已删除项目的 AgentSession（含 extension runner、上下文、bash 子进程等资源）在内存中最多再存活 30 分钟（domain 定时器会兜底），期间占用 LLM 上下文内存；若进程同时存活多个被删项目会积累。
- 建议：删除/归档路由调用 `clearIdleRuntimeCleanup + closeRuntime`。

### 6.5 [低] piSessionId 别名 entry 泄漏
- `createSession` 在 `piSessionId` 下建 entry 后从不删除（仅 reloadIdleRuntimes 在 stopped 时删）。每个创建的会话在 registry 里留下一个含 prompt 的 entry，长期运行内存缓慢增长。进程重启即释放。

### 6.6 [低] 双 30 分钟定时器冗余
- 同一 session 同时存在 domain 与 client 两个定时器，行为重复（closeRuntime 幂等所以无害），但语义混乱且是 6.1 的根因。建议统一为单一来源（如全走 domain 层，或 closeRuntime 幂等 + client 定时器只在 rebuild 时设且 always reset）。

### 6.7 [低] 并发发送竞态（多窗口）
- 路由 busy 检查（sessions.ts:620-622）与 startSessionRun L129 都是**非原子读**；`markSessionRunning` 在 ensureRuntime 之后（L335）。两个并发 POST 可同时通过检查 → 双 prompt，第二个被 AgentSession 抛 "Agent is already processing" → 第二个 run 的 doCleanup 可能把 DB 置 idle（第一个还在跑），短暂出现 DB=idle 而 agent 在流式的不一致窗口。
- 缓解：AgentSession 本身会拒绝第二个 prompt 并走错误 cleanup，不会永久卡死；但建议用条件更新原子认领（vision 路径已是该模式，sessions.ts:647-652）。

### 6.8 [低] safety timeout 与状态窗口
- timeout 触发时 agent 可能仍在后台生成（abort 是 fire-and-forget），但 DB 已 idle + 订阅已退订；此时新消息可能撞上 `isStreaming` 抛 `pi_session_busy`。有子会话/跨项目等待豁免（L293-329）降低误杀率，但"idle 但 agent 未完全停"的窗口存在。

### 6.9 环境变量
- `PIPLUS_SESSION_TIMEOUT_MS`（runtime.ts:107）可覆盖默认 10 分钟 safety timeout；TTL 常量 `NON_WORKER_IDLE_RUNTIME_TTL_MS` 与 client 侧 `30 * 60 * 1000` 硬编码（client.ts:425、551）**没有环境变量**，且两处需同步修改。

---

## 7. 关键行号索引

### packages/domain/src/session/runtime.ts
- L9 `NON_WORKER_IDLE_RUNTIME_TTL_MS`；L11 `idleRuntimeCleanupTimers` Map
- L13-19 `clearIdleRuntimeCleanup`；L21-30 `scheduleIdleRuntimeCleanup`
- L83-91 `markSessionRunning`；L93-101 `markSessionIdle`
- L104-424 `startSessionRun`；L116 起始清定时器；L129 busy 检查；L150 ensureRuntime
- L231-284 `doCleanup`（L250-256 abort、L258-259 清 context、L260 markIdle、L270-275 worker 立即回收、L277-279 非 worker 调度 30min）
- L286-331 safety timeout（L293-329 子会话/跨项目豁免）；L335 markSessionRunning；L356-367 订阅；L374-424 attemptSend；L424 void attemptSend
- L436-493 `reloadProjectSessionRuntimes`

### packages/pi-client/src/client.ts
- L25-26 单例；L96-102 getOrCreateSession
- L345-428 `restoreRuntime`（L421-425 client 定时器）
- L430-556 `ensureRuntime`（L438-443 tools 变更重建；L444-448 early-return 不刷新定时器；L547-551 client 定时器）
- L585-615 sendMessage 正常路径；L619-656 stub 路径（runtime 缺失时 echo 落盘）
- L672-683 `stopSession`（stopped=true，abort 后台）；L684-698 `closeRuntime`
- L708-725 `reloadIdleRuntimes`（仅 stopped 且不置空 agentSession）

### packages/pi-client/src/runtime-registry.ts
- L12-34 `ActiveSessionRuntime` 类型（L33 idleCleanupTimer）
- L37-70 `RuntimeRegistry`；L79-88 hasHistory/isFirstConversation；L90-102 `closeIdle`

### apps/api
- routes/sessions.ts：L601-880 chat/messages（L754 startSessionRun；L647-652 vision 原子认领）；L963-977 /stop；L992-1008 /archive；L1750-1785 /compact；L1787-1802 /restore-runtime
- routes/projects.ts：L697-721 角色配置（L718 reloadProjectSessionRuntimes）；L725-750 项目删除（不回收 runtime）
- routes/packages.ts：L241 reloadIdleRuntimes
- db-context.ts：L15-27 recoverStuckSessions；index.ts：L12 启动时调用
- desktop/src/main/api-process.ts：SIGTERM 强杀，无优雅关闭

### packages/domain/src
- extensions/role-manager-tools.ts：L193 spawn_session（默认 'worker'）；L456-493 startChildSessionRun
- extensions/role-catalog.ts：L16 角色列表（planner/worker/reviewer/feature_lead/bugfix_lead）
- db/schema.ts：L62 runtimeStatus 默认 'idle'
