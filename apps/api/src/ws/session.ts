import type { ClientMessage, ServerMessage } from '@piplus/shared/ws';

type ConnectionContext = {
  project_id?: string;
  session_id?: string;
  current_tab?: 'chat' | 'session_info' | 'git_diff';
};

type AttachedSocket = {
  send(data: string): void;
};

const sockets = new Set<AttachedSocket>();
const contexts = new WeakMap<AttachedSocket, ConnectionContext>();

function shouldDeliver(_message: ServerMessage, _context?: ConnectionContext) {
  // 所有消息广播到所有已连接 socket，由前端自行按 session_id / tab 过滤
  return true;
}

export function registerSocket() {
  return {
    attach(ws: AttachedSocket) {
      sockets.add(ws);
      contexts.set(ws, {});
    },
    detach(ws: AttachedSocket) {
      sockets.delete(ws);
      contexts.delete(ws);
    },
    setContext(ws: AttachedSocket, context: ConnectionContext) {
      contexts.set(ws, context);
    },
    handleClientMessage(ws: AttachedSocket, message: ClientMessage) {
      if (message.type === 'set_context') {
        contexts.set(ws, message.payload);
      }
    },
    broadcast(message: ServerMessage) {
      const payload = JSON.stringify(message);
      for (const ws of sockets) {
        const context = contexts.get(ws);
        if (!shouldDeliver(message, context)) continue;
        ws.send(payload);
      }
    },
    sendToSession(sessionId: string, message: ServerMessage) {
      if (message.kind === 'event') {
        this.broadcast(message);
        return;
      }

      console.log('[ws/server] sendToSession', { sessionId, kind: message.kind, phase: (message as any).phase ?? null });
      // chat_stream 改为广播，由前端按 session_id 自行过滤，避免 server 端 context 串线
      this.broadcast(message);
    },
  };
}
