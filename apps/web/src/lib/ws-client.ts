import type { ClientMessage } from '@piplus/shared';
import { getToken, LOGOUT_EVENT_NAME } from './auth-session';
import { getWsBaseUrl } from './runtime-config';

export function nextReconnectDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 30000);
}

/** 客户端心跳周期。服务端收到 ping 会回 `connection.pong`（apps/api/src/ws/server.ts）。 */
export const HEARTBEAT_INTERVAL_MS = 25_000;
/**
 * 静默容忍窗口：连续 2 个心跳周期未收到任何消息（含 pong）即判定为半开连接。
 * 由静默看门狗精确计时（收到任何消息都重置），不与 ping 的 tick 相位相关。
 */
export const HEARTBEAT_SILENCE_TIMEOUT_MS = HEARTBEAT_INTERVAL_MS * 2;

const INITIAL_CONNECT_DELAY = 0;

export function createWorkspaceSocket({
  onMessage,
  onOpen,
  onClose,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
  heartbeatSilenceTimeoutMs = heartbeatIntervalMs * 2,
}: {
  onMessage: (event: MessageEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
  /** 心跳周期（生产用默认值，测试可注入短周期） */
  heartbeatIntervalMs?: number;
  /** 静默容忍窗口，默认 2 个心跳周期 */
  heartbeatSilenceTimeoutMs?: number;
}) {
  let ws: WebSocket;
  let reconnectAttempt = 0;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (silenceTimer !== null) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  /**
   * 静默看门狗：连接建立、以及之后每收到任何入站消息（pong / chat_stream / 事件）时重置。
   * 超过静默窗口没收到任何消息 → 判定半开连接，主动关闭以走既有 close → 指数退避重连 → onOpen 补拉。
   */
  function armSilenceWatchdog() {
    if (silenceTimer !== null) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      // 连接未 OPEN 时不处理：close/error 事件会带我们进入重连路径，避免误判
      if (closed || ws.readyState !== WebSocket.OPEN) return;
      stopHeartbeat();
      try {
        ws.close();
      } catch {
        // 关闭失败不阻塞：readyState 异常时 close 事件/下一次重连仍会兜底
      }
    }, heartbeatSilenceTimeoutMs);
  }

  function startHeartbeat() {
    stopHeartbeat();
    armSilenceWatchdog();
    heartbeatTimer = setInterval(sendPing, heartbeatIntervalMs);
  }

  function connect() {
    if (closed) return;
    ws = new WebSocket(`${getWsBaseUrl()}/ws`);

    ws.addEventListener('message', (event) => {
      // 任何入站消息都说明链路存活（含 connection.pong）：重置静默看门狗
      if (heartbeatTimer !== null) armSilenceWatchdog();
      onMessage(event);
    });

    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      startHeartbeat();
      onOpen?.();
    });

    ws.addEventListener('close', (event) => {
      stopHeartbeat();
      onClose?.();
      // 4401 = 服务端认证失败/超时未认证：不再重连，并广播登出事件引导重新登录。
      const code = (event as CloseEvent | undefined)?.code;
      if (code === 4401) {
        closed = true;
        if (connectTimer) {
          clearTimeout(connectTimer);
          connectTimer = null;
        }
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(LOGOUT_EVENT_NAME));
        }
        return;
      }
      if (!closed) {
        reconnectTimer = setTimeout(connect, nextReconnectDelay(reconnectAttempt++));
      }
    });

    ws.addEventListener('error', () => {
      // close event follows error, handled above
    });
  }

  connectTimer = setTimeout(connect, INITIAL_CONNECT_DELAY);

  function safeSend(message: ClientMessage) {
    if (!ws) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  function sendPing() {
    safeSend({
      kind: 'client',
      type: 'ping',
      payload: { timestamp: new Date().toISOString() },
    } satisfies ClientMessage);
  }

  return {
    hello() {
      safeSend({
        kind: 'client',
        type: 'hello',
        payload: { user_agent: navigator.userAgent, token: getToken() ?? undefined },
      } satisfies ClientMessage);
    },
    setContext(payload: {
      project_id?: string;
      session_id?: string;
      current_tab?: 'chat' | 'session_info' | 'git_diff' | 'files' | 'terminal';
    }) {
      safeSend({ kind: 'client', type: 'set_context', payload } satisfies ClientMessage);
    },
    ping() {
      sendPing();
    },
    subscribeSession(sessionId: string) {
      safeSend({
        kind: 'client',
        type: 'subscribe_session',
        payload: { session_id: sessionId },
      } satisfies ClientMessage);
    },
    unsubscribeSession(sessionId: string) {
      safeSend({
        kind: 'client',
        type: 'unsubscribe_session',
        payload: { session_id: sessionId },
      } satisfies ClientMessage);
    },
    sendRaw(message: Record<string, unknown>) {
      safeSend(message as any);
    },
    close() {
      closed = true;
      stopHeartbeat();
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        ws.close();
      }
    },
  };
}
