/**
 * 平台级长等待 pin 豁免（refcount）。
 *
 * 场景：domain 在父会话中等待子会话 writeback、跨项目等待等合法长等待期间，
 * 父会话可能长时间既不产生 stream 事件也不结束流式（甚至 isStreaming 持续为 true）。
 * 此时 pi-client 的 idle runtime 回收（含卡死兜底强杀）必须完全豁免，
 * 否则会 dispose 在途 turn → 子会话 writeback 结果永远进不了父会话上下文。
 *
 * 由 domain 的等待循环在进入等待前 pin、在 finally 中 unpin；
 * refcount 支持嵌套/并发等待。pi-client 仅持有计数本身，避免循环依赖。
 *
 * **pin 生命周期无界（已知取舍）**：等待多久就豁免多久，不设时长上限——上限会在长等待
 * 末端解除豁免时立刻强杀，重现子会话 writeback 结果永远进不了父会话上下文的事故。
 * 解除只能来自显式终结信号（子 writeback / 父 missing / stopping / idle 检测 / 进程重启），
 * 完整清单与监控建议见 docs/session-runtime-reclamation.md「0.1 pin 生命周期无界」。
 */

const pinnedSessions = new Map<string, number>();

/** pin refcount +1 */
export function pinSessionRuntime(sessionId: string): void {
  if (!sessionId) return;
  pinnedSessions.set(sessionId, (pinnedSessions.get(sessionId) ?? 0) + 1);
}

/** pin refcount -1，floor 0（未 pin 时 no-op） */
export function unpinSessionRuntime(sessionId: string): void {
  if (!sessionId) return;
  const count = pinnedSessions.get(sessionId);
  if (count === undefined) return;
  if (count <= 1) {
    pinnedSessions.delete(sessionId);
    return;
  }
  pinnedSessions.set(sessionId, count - 1);
}

export function isSessionRuntimePinned(sessionId: string): boolean {
  return (pinnedSessions.get(sessionId) ?? 0) > 0;
}

/** 清空全部 pin（仅供测试；生产由 domain 的 pin/unpin 配对维护）。 */
export function resetSessionRuntimePins(): void {
  pinnedSessions.clear();
}
