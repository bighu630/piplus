import type { ClientMessage, ServerMessage } from '@piplus/shared/ws';

type AttachedSocket = {
  send(data: string): void;
};

const sockets = new Set<AttachedSocket>();
const subscriptions = new WeakMap<AttachedSocket, Set<string>>();

function isSubscribed(ws: AttachedSocket, sessionId: string | undefined): boolean {
  if (!sessionId) return false;
  return subscriptions.get(ws)?.has(sessionId) ?? false;
}

/**
 * 控制面事件白名单：虽然带 scope.session_id，但前端依赖它们全局刷新侧边栏树，
 * 必须保持广播，不参与订阅过滤。
 */
const GLOBAL_EVENT_TYPES = new Set([
  'session.runtime_status_changed',
  'tree.changed',
  'project.created',
  'session.created',
  'session.archived',
  'session.updated',
]);

/**
 * 服务端按会话定向过滤，区分两类事件：
 * - 控制面事件：无 scope.session_id 的全局事件，以及 GLOBAL_EVENT_TYPES 白名单中的
 *   控制面事件（即使带 scope.session_id），一律广播给所有连接（侧边栏树/状态灯需要）
 * - 会话私有事件：chat_stream、terminal 及其余会话私有事件仅投递给已订阅该会话的连接
 */
function shouldDeliver(message: ServerMessage, ws: AttachedSocket): boolean {
  if (message.kind === 'event') {
    if (!message.scope?.session_id) return true;
    if (GLOBAL_EVENT_TYPES.has(message.type)) return true;
    return isSubscribed(ws, message.scope.session_id);
  }
  if (message.kind === 'chat_stream') {
    return isSubscribed(ws, message.scope.session_id);
  }
  if (message.kind === 'terminal') {
    return isSubscribed(ws, message.payload.sessionId);
  }
  return true;
}

function deliver(message: ServerMessage) {
  const payload = JSON.stringify(message);
  for (const ws of sockets) {
    if (!shouldDeliver(message, ws)) continue;
    try {
      ws.send(payload);
    } catch (err) {
      console.warn('[ws-session] send failed, removing socket', err);
      sockets.delete(ws);
      subscriptions.delete(ws);
    }
  }
}

export function registerSocket() {
  const hub = {
    attach(ws: AttachedSocket) {
      sockets.add(ws);
      subscriptions.set(ws, new Set());
    },
    detach(ws: AttachedSocket) {
      sockets.delete(ws);
      subscriptions.delete(ws);
    },
    handleClientMessage(ws: AttachedSocket, message: ClientMessage) {
      if (message.type === 'subscribe_session') {
        subscriptions.get(ws)?.add(message.payload.session_id);
      } else if (message.type === 'unsubscribe_session') {
        subscriptions.get(ws)?.delete(message.payload.session_id);
      }
    },
    broadcast(message: ServerMessage) {
      deliver(message);
    },
    /**
     * 兼容保留：投递完全由消息内容（scope/payload.session_id）+ 各连接订阅集合决定，
     * sessionId 参数仅为兼容既有调用点而保留，不参与过滤。
     */
    sendToSession(_sessionId: string, message: ServerMessage) {
      deliver(message);
    },
  };
  return hub;
}
