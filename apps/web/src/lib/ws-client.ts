'use client';

import type { ClientMessage } from '@piplus/shared';
import { getWsBaseUrl } from './runtime-endpoints';

export function createWorkspaceSocket(onMessage: (event: MessageEvent) => void) {
  const socket = new WebSocket(`${getWsBaseUrl()}/ws`);
  socket.addEventListener('message', onMessage);
  return {
    socket,
    hello() {
      socket.send(JSON.stringify({ kind: 'client', type: 'hello', payload: { user_agent: navigator.userAgent } } satisfies ClientMessage));
    },
    setContext(payload: { project_id?: string; session_id?: string; current_tab?: 'chat' | 'session_info' }) {
      socket.send(JSON.stringify({ kind: 'client', type: 'set_context', payload } satisfies ClientMessage));
    },
    ping() {
      socket.send(JSON.stringify({ kind: 'client', type: 'ping', payload: { timestamp: new Date().toISOString() } } satisfies ClientMessage));
    },
    close() {
      socket.close();
    },
  };
}
