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
