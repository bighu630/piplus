/**
 * 强制回收（卡死兜底强杀）通知 hook。
 *
 * closeRuntime 在无进展超时后仍会强制 dispose 在途 runtime（僵尸兜底，不能去掉），
 * 但该动作会 abort 在途 turn；上层（domain）需要感知并做善后（如把等待中的
 * 子会话/工具调用标记失败、写回错误而非静默丢失结果）。
 * pi-client 只负责通知，不感知 domain 语义。
 */

export type ForcedRuntimeDisposeInfo = {
  sessionId: string;
  disposedAt: number;
  attempts: number;
  noProgressMs: number;
};

export type ForcedRuntimeDisposeHandler = (info: ForcedRuntimeDisposeInfo) => void | Promise<void>;

const handlers = new Set<ForcedRuntimeDisposeHandler>();

export function registerForcedRuntimeDisposeHandler(handler: ForcedRuntimeDisposeHandler): void {
  handlers.add(handler);
}

/** 清空全部 handler（仅供测试）。 */
export function clearForcedRuntimeDisposeHandlers(): void {
  handlers.clear();
}

/**
 * 串行 await 通知所有 handler；单个 handler 抛错只 console.error，
 * 不影响其它 handler，也不向外抛（调用方为 fire-and-forget）。
 */
export async function notifyForcedRuntimeDispose(info: ForcedRuntimeDisposeInfo): Promise<void> {
  for (const handler of Array.from(handlers)) {
    try {
      await handler(info);
    } catch (err) {
      console.error('[pi-client] forced runtime dispose handler failed', {
        sessionId: info.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
