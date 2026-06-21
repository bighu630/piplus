'use client';

import type { ClientMessage } from '@piplus/shared';
import { getWsBaseUrl } from './runtime-endpoints';

const RECONNECT_DELAY = 2000;

export function createWorkspaceSocket({
  onMessage,
  onOpen,
}: {
  onMessage: (event: MessageEvent) => void;
  onOpen?: () => void;
}) {
  let ws: WebSocket;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect() {
    if (closed) return;
    ws = new WebSocket(`${getWsBaseUrl()}/ws`);

    ws.addEventListener('message', onMessage);

    ws.addEventListener('open', () => {
      console.log('[ws-client] connected');
      onOpen?.();
    });

    ws.addEventListener('close', () => {
      if (!closed) {
        console.log('[ws-client] disconnected, reconnecting in', RECONNECT_DELAY);
        reconnectTimer = setTimeout(connect, RECONNECT_DELAY);
      }
    });

    ws.addEventListener('error', () => {
      // close 事件会紧随 error 触发，所以只需处理 close
    });
  }

  connect();

  function safeSend(message: ClientMessage) {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(message));
  }

  return {
    hello() {
      safeSend({ kind: 'client', type: 'hello', payload: { user_agent: navigator.userAgent } } satisfies ClientMessage);
    },
    setContext(payload: { project_id?: string; session_id?: string; current_tab?: 'chat' | 'session_info' }) {
      safeSend({ kind: 'client', type: 'set_context', payload } satisfies ClientMessage);
    },
    ping() {
      safeSend({ kind: 'client', type: 'ping', payload: { timestamp: new Date().toISOString() } } satisfies ClientMessage);
    },
    close() {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws.close();
    },
  };
}
