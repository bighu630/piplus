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

import { pinSessionRuntime, unpinSessionRuntime } from '@piplus/pi-client/runtime-pins';

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

// A2 接线：等待标记与 pi-client 的 runtime 回收豁免共用同一份 pin 状态。
// 跨项目等待期间父会话长时间无 stream 事件，pi-client 的 idle-reclaim（含卡死兜底强杀）
// 必须完全豁免；否则 dispose 在途 turn → 跨项目回复永远进不了父会话上下文。
// pin/unpin 与条目生命周期严格一一对应（首次置位 pin，条目实际删除时 unpin），
// 幂等重复 clear 不得欠计数。

/** 标记某会话正在等待跨项目回复（in-flight cross-project ask）。
 *  pin 生命周期同样无界（等待多久就豁免多久）：见
 *  docs/session-runtime-reclamation.md「0.1 pin 生命周期无界」。 */
export function setCrossProjectWait(sessionId: string, requestId: string) {
  const existed = crossProjectWait.has(sessionId);
  crossProjectWait.set(sessionId, { requestId, startedAt: Date.now() });
  // 仅首次置位 pin：重复 set（刷新 requestId）不得叠加 refcount
  if (!existed) pinSessionRuntime(sessionId);
}

/** 清除跨项目等待标记（wait 结束或会话清理时调用）；仅在条目确实存在时解除 pin。 */
export function clearCrossProjectWait(sessionId: string) {
  if (!crossProjectWait.delete(sessionId)) return; // 原本不存在 → 幂等 no-op（否则欠计数）
  unpinSessionRuntime(sessionId);
}

/** 查询某会话是否正在等待跨项目回复。 */
export function isCrossProjectWaiting(sessionId: string): boolean {
  return crossProjectWait.has(sessionId);
}

type WaitingOnChildEntry = { requestId: string; childSessionId: string; startedAt: number };
// waitingOnChild 内存标记：父会话 waitForChildWriteback 轮询期间置位，供 runtime 的
// safety timeout 作豁免依据——不依赖子会话瞬时 DB 状态（子 run 结束未 writeback / 子被
// 自身超时杀 / writeback 落库前都存在 idle 窗口，DB 查询恰好落在窗口会误杀父会话）。
// 结构为 parentSessionId → (childSessionId → entry) 的两级 Map：父会话并行
// spawn_session(wait=true) 等多个子会话时，各 wait 循环的标记互不覆盖；任一 wait 循环
// 退出只清理自己那个子会话，其余等待的豁免不受影响。
// API 重启丢失标记可接受：卡死会话由重启后的 recoverStuckSessions 兜底回收。
const waitingOnChild = new Map<string, Map<string, WaitingOnChildEntry>>();

/**
 * 标记某会话（父）正在 waitForChildWriteback 轮询中，等待指定子会话 writeback。
 * 同一 (父, 子) 重复调用 = 刷新 entry（requestId/startedAt），不产生重复条目。
 *
 * A2 接线：首次置位时 pin 住父会话的 runtime（禁止 pi-client 回收/强杀）——
 * 父在 wait 期间自身不产生 stream 事件，若 pi-client 强杀会 dispose 在途 turn，
 * 子会话 writeback 结果将永远进不了父会话上下文（线上事故）。
 * refcount 与 (父,子) 条目一一对应，重复 set 刷新不重复 pin。
 *
 * pin 的生命周期无界（等待多久就豁免多久）及其唯一出口：见
 * docs/session-runtime-reclamation.md「0.1 pin 生命周期无界」。
 */
export function setWaitingOnChild(parentSessionId: string, requestId: string, childSessionId: string) {
  let byChild = waitingOnChild.get(parentSessionId);
  if (!byChild) {
    byChild = new Map<string, WaitingOnChildEntry>();
    waitingOnChild.set(parentSessionId, byChild);
  }
  const existed = byChild.has(childSessionId);
  byChild.set(childSessionId, { requestId, childSessionId, startedAt: Date.now() });
  if (!existed) pinSessionRuntime(parentSessionId);
}

/**
 * 清除等待子会话标记（wait 循环退出或会话清理时调用）。
 * - 指定 childSessionId：只清该子会话的条目（并行 wait 时先退出者不影响其他等待）。
 * - 不指定：清空该父会话的全部条目（会话清理路径）。
 * - 对不存在的父/子条目是幂等 no-op。
 *
 * A2 接线：仅在条目确实存在时才 unpin（每个 (父,子) 条目对应一次 pin）；
 * 幂等重复 clear 绝不欠计数——否则并行相邻等待会因 refcount 提前归零而被强杀。
 */
export function clearWaitingOnChild(parentSessionId: string, childSessionId?: string) {
  if (childSessionId === undefined) {
    const byChild = waitingOnChild.get(parentSessionId);
    if (!byChild) return;
    const pinnedCount = byChild.size;
    waitingOnChild.delete(parentSessionId);
    // 按实际存在的条目数逐条 unpin（与每个条目一次 pin 严格配对）
    for (let i = 0; i < pinnedCount; i++) unpinSessionRuntime(parentSessionId);
    return;
  }
  const byChild = waitingOnChild.get(parentSessionId);
  if (!byChild) return;
  if (!byChild.delete(childSessionId)) return; // 条目不存在 → 幂等 no-op（欠计数保护）
  unpinSessionRuntime(parentSessionId);
  if (byChild.size === 0) waitingOnChild.delete(parentSessionId);
}

/** 查询某会话是否正在等待子会话 writeback（仍有任意 child 在等；safety timeout 豁免 1 依据）。 */
export function isWaitingOnChild(parentSessionId: string): boolean {
  const byChild = waitingOnChild.get(parentSessionId);
  return byChild !== undefined && byChild.size > 0;
}

/**
 * 诊断/测试用：某父会话当前在等的子会话数量。
 * 生产代码无调用方——仅供测试断言与调试观测，**不得**用于任何行为判定
 * （行为判定用 isWaitingOnChild / isWaitedOnByParent）。
 */
export function countWaitingChildren(parentSessionId: string): number {
  return waitingOnChild.get(parentSessionId)?.size ?? 0;
}

/**
 * 精确匹配「父正在等的是这个子会话」——safety timeout 豁免 4 依据。
 * 并行多子时每个 child 各自独立匹配，兄弟子会话不牵连。
 */
export function isWaitedOnByParent(parentSessionId: string, childSessionId: string): boolean {
  return waitingOnChild.get(parentSessionId)?.has(childSessionId) ?? false;
}
