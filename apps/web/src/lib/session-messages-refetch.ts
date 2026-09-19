/**
 * 运行中会话消息（GET /sessions/:id/chat/messages?cursor=...）的轮询间隔决策。
 *
 * useInfiniteQuery 的普通 refetch 会按已加载页数 N 重放 queryFn（每页一个 cursor），
 * 而 `staleTime: 0` + 1.5s 轮询会让请求量随已加载页数线性放大。因此：
 *
 * - 非 running：不轮询（落库消息由 WS 的 complete/idle/session.messages_changed 事件 invalidate 驱动）。
 * - running 且 WS 已连接：不轮询，依赖 WS 事件（assistant complete、工具结果 messages_changed）+ useChatStream 流式快照。
 * - running 且 WS 断开：5000ms 兜底，避免断线/漏推时 UI 一直停在运行中。
 *
 * 保留 onOpen / refetchOnReconnect / refetchOnWindowFocus 等既有刷新路径。
 */
export const RUNNING_MESSAGES_FALLBACK_REFETCH_MS = 5000;

export function computeSessionMessagesRefetchInterval(
  runtimeStatus: string,
  wsConnected: boolean,
): number | false {
  return runtimeStatus === 'running' && !wsConnected
    ? RUNNING_MESSAGES_FALLBACK_REFETCH_MS
    : false;
}
