/**
 * 等待用户回答的会话集合（ask_question pending）。
 * 用于豁免 idle 回收与 closeRuntime 的 isStreaming 重试逻辑：
 * - pi-client 不应回收正在等待用户回答的 runtime；
 * - domain 的 safetyTimeout 也不应超时等待中的会话。
 *
 * 由 domain 的 ask-question 模块通过 registerAskPendingHooks 驱动，
 * pi-client 仅持有集合本身，避免循环依赖。
 */

const pendingSessions = new Set<string>();

export function markAskPending(sessionId: string): void {
  if (sessionId) pendingSessions.add(sessionId);
}

export function unmarkAskPending(sessionId: string): void {
  // 仅当 domain 已无该会话的 pending 时才真正清除（domain 侧已做 hasOther 判断，此处兜底）
  pendingSessions.delete(sessionId);
}

export function isAskPending(sessionId: string): boolean {
  return pendingSessions.has(sessionId);
}

export function clearAskPending(sessionId: string): void {
  pendingSessions.delete(sessionId);
}
