import type { ClientMessage } from '@piplus/shared';
import { getWsBaseUrl } from './runtime-config';

const RECONNECT_DELAY = 2000;
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
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let connectTimer: ReturnType<typeof setTimeout> | null = null;

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

  connectTimer = setTimeout(connect, INITIAL_CONNECT_DELAY);

  function safeSend(message: ClientMessage) {
    if (!ws) {
      console.warn('[WS] safeSend skipped: ws not initialized');
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] safeSend skipped: ws not open, state:', ws.readyState);
      return;
    }
    const raw = JSON.stringify(message);
    console.log('[WS] sending:', raw);
    ws.send(raw);
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
