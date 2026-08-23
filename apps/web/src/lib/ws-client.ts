import type { ClientMessage } from '@piplus/shared';
import { getToken, LOGOUT_EVENT_NAME } from './auth-session';
import { getWsBaseUrl } from './runtime-config';

export function nextReconnectDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 30000);
}

const INITIAL_CONNECT_DELAY = 0;

export function createWorkspaceSocket({
  onMessage,
  onOpen,
  onClose,
}: {
  onMessage: (event: MessageEvent) => void;
  onOpen?: () => void;
  onClose?: () => void;
}) {
  let ws: WebSocket;
  let reconnectAttempt = 0;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    ws = new WebSocket(`${getWsBaseUrl()}/ws`);

    ws.addEventListener('message', onMessage);

    ws.addEventListener('open', () => {
      reconnectAttempt = 0;
      onOpen?.();
    });

    ws.addEventListener('close', (event) => {
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
      safeSend({
        kind: 'client',
        type: 'ping',
        payload: { timestamp: new Date().toISOString() },
      } satisfies ClientMessage);
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
