// 会话流式状态快照（纯函数，无 React 依赖）
// 语义与 TabChat.tsx 原有 WS 订阅 effect 一一对应，供 ws-provider 按 sessionId 全局累积

export type StreamPhase = 'idle' | 'streaming' | 'complete' | 'error';

export interface StreamRuntimeError {
  runId: string;
  error: string;
}

export interface ChatStreamSnapshot {
  phase: StreamPhase;
  streamingContent: string;
  streamNote: string;
  runtimeErrors: StreamRuntimeError[];
}

export const INITIAL_CHAT_STREAM_SNAPSHOT: ChatStreamSnapshot = {
  phase: 'idle',
  streamingContent: '',
  streamNote: '',
  runtimeErrors: [],
};

export type ChatStreamEvent =
  | { type: 'start'; delta: string }
  | { type: 'delta'; delta: string }
  | { type: 'complete' }
  | { type: 'error'; error: string; runId: string }
  | { type: 'runtime_idle' };

// 节流 flush 器：合并高频 push 为最后一次 flush，供 useChatStream 的 80ms 节流使用（纯工具，可单测）
// 语义：push 存 latest；无 pending timer 时起 setTimeout(delayMs) 后 flush(latest)；
//       immediate=true 时清 pending timer 立即 flush(latest)；dispose 清理 timer 并禁止后续 flush
export function createThrottledFlusher<T>(
  flush: (value: T) => void,
  delayMs: number,
): { push: (value: T, immediate?: boolean) => void; dispose: () => void } {
  let latest: T | undefined = undefined;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flushNow = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed) return;
    flush(latest as T);
  };

  return {
    push(value, immediate = false) {
      if (disposed) return;
      latest = value;
      if (immediate) {
        flushNow();
        return;
      }
      // 无 pending timer 时才起定时器；已有 timer 则仅更新 latest（合并到下一次 flush）
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          flush(latest as T);
        }, delayMs);
      }
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

export function reduceChatStreamSnapshot(
  snap: ChatStreamSnapshot,
  event: ChatStreamEvent,
): ChatStreamSnapshot {
  switch (event.type) {
    case 'start':
      // 新一轮流开始：重置内容与错误，streamNote 按首段 delta 是否为空区分
      return {
        phase: 'streaming',
        streamingContent: '',
        streamNote: event.delta ? 'start · streaming' : 'start',
        runtimeErrors: [],
      };
    case 'delta':
      // 追加增量内容，其余字段保持不变
      return {
        ...snap,
        phase: 'streaming',
        streamingContent: snap.streamingContent + event.delta,
      };
    case 'complete':
      // 仅切换 phase，保留 streamingContent（下游桥接依赖它）
      return { ...snap, phase: 'complete' };
    case 'error':
      // 流式错误：清空内容并记录错误
      return {
        phase: 'error',
        streamingContent: '',
        streamNote: '',
        runtimeErrors: [{ runId: event.runId, error: event.error }],
      };
    case 'runtime_idle':
      // 会话运行结束：全清回初始快照
      return INITIAL_CHAT_STREAM_SNAPSHOT;
  }
}
