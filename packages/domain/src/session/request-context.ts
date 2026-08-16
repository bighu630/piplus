/**
 * In-memory request context for cross-session wait coordination.
 *
 * When a parent spawns a child (or sends a follow-up message) with wait=true,
 * the framework binds a unique requestId to the target child session.
 * Later, writeback_to_parent reads this requestId so the parent can
 * match the response to the exact request.
 *
 * We use a singleton map keyed by sessionId.  Because the runtime already
 * enforces "one active run per session", there is never more than one
 * outstanding request for a given session at a time.
 */

type RequestContextEntry = {
  requestId: string;
  startedAt: number;
};

const ctx = new Map<string, RequestContextEntry>();

export function setRequestContext(sessionId: string, requestId: string) {
  ctx.set(sessionId, { requestId, startedAt: Date.now() });
}

export function getRequestContext(sessionId: string): RequestContextEntry | undefined {
  return ctx.get(sessionId);
}

export function clearRequestContext(sessionId: string) {
  ctx.delete(sessionId);
}

type CrossProjectWaitEntry = { requestId: string; startedAt: number };
const crossProjectWait = new Map<string, CrossProjectWaitEntry>();

/** 标记某会话正在等待跨项目回复（in-flight cross-project ask）。 */
export function setCrossProjectWait(sessionId: string, requestId: string) {
  crossProjectWait.set(sessionId, { requestId, startedAt: Date.now() });
}

/** 清除跨项目等待标记（wait 结束或会话清理时调用）。 */
export function clearCrossProjectWait(sessionId: string) {
  crossProjectWait.delete(sessionId);
}

/** 查询某会话是否正在等待跨项目回复。 */
export function isCrossProjectWaiting(sessionId: string): boolean {
  return crossProjectWait.has(sessionId);
}

type WaitingOnChildEntry = { requestId: string; childSessionId: string; startedAt: number };
// waitingOnChild 内存标记：父会话 waitForChildWriteback 轮询期间置位，供 runtime 的
// safety timeout 作豁免依据——不依赖子会话瞬时 DB 状态（子 run 结束未 writeback / 子被
// 自身超时杀 / writeback 落库前都存在 idle 窗口，DB 查询恰好落在窗口会误杀父会话）。
// API 重启丢失标记可接受：卡死会话由重启后的 recoverStuckSessions 兜底回收。
const waitingOnChild = new Map<string, WaitingOnChildEntry>();

/** 标记某会话（父）正处于 waitForChildWriteback 轮询中，等待其子会话 writeback。key 为父 sessionId。 */
export function setWaitingOnChild(sessionId: string, requestId: string, childSessionId: string) {
  waitingOnChild.set(sessionId, { requestId, childSessionId, startedAt: Date.now() });
}

/** 清除等待子会话标记（wait 循环退出或会话清理时调用）。 */
export function clearWaitingOnChild(sessionId: string) {
  waitingOnChild.delete(sessionId);
}

/** 查询某会话是否正在等待子会话 writeback（safety timeout 豁免依据）。 */
export function isWaitingOnChild(sessionId: string): boolean {
  return waitingOnChild.has(sessionId);
}

/** 查询某会话的等待子会话标记条目（豁免精确匹配需读取 entry.childSessionId）。 */
export function getWaitingOnChild(sessionId: string): WaitingOnChildEntry | undefined {
  return waitingOnChild.get(sessionId);
}
