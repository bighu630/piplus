import type { ClientMessage } from '@piplus/shared';
import { getWsBaseUrl } from './constants';

const RECONNECT_DELAY = 2000;

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
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    ws = new WebSocket(`${getWsBaseUrl()}/ws`);

    ws.addEventListener('message', onMessage);

    ws.addEventListener('open', () => {
      onOpen?.();
    });

    ws.addEventListener('close', () => {
      onClose?.();
      if (!closed) {
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
      }
    });

    ws.addEventListener('error', () => {
      // close event follows error, handled above
    });
  }

  connect();

  function safeSend(message: ClientMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  return {
    hello() {
      safeSend({
        kind: 'client',
        type: 'hello',
        payload: { user_agent: navigator.userAgent },
      } satisfies ClientMessage);
    },
    setContext(payload: {
      project_id?: string;
      session_id?: string;
      current_tab?: 'chat' | 'session_info' | 'git_diff';
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
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws.close();
    },
  };
}
