import { describe, expect, test } from 'bun:test';
import { registerSocket } from './session';
import { createChatStreamFrame, createEvent } from './protocol';

function createMockSocket() {
  return {
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

describe('ws session hub', () => {
  test('delivers global events to all sockets regardless of subscription', () => {
    const hub = registerSocket();
    const a = createMockSocket();
    const b = createMockSocket();
    hub.attach(a);
    hub.attach(b);

    hub.broadcast(createEvent('tree.changed', { project_id: 'p1' }, { project_id: 'p1' }));
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  test('broadcasts session.runtime_status_changed to all sockets by design', () => {
    const hub = registerSocket();
    const subscribed = createMockSocket();
    const unsubscribed = createMockSocket();
    hub.attach(subscribed);
    hub.attach(unsubscribed);
    hub.handleClientMessage(subscribed, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createEvent('session.runtime_status_changed', { runtime_status: 'running' }, { session_id: 's1' }));
    expect(subscribed.sent).toHaveLength(1);
    expect(unsubscribed.sent).toHaveLength(1); // 全局：侧边栏需要所有会话状态
  });

  test('delivers chat_stream only to sockets subscribed to the session', () => {
    const hub = registerSocket();
    const subscriber = createMockSocket();
    const other = createMockSocket();
    hub.attach(subscriber);
    hub.attach(other);
    hub.handleClientMessage(subscriber, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'hello'));
    expect(subscriber.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  test('stops delivering chat_stream after unsubscribe', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });
    hub.handleClientMessage(socket, { kind: 'client', type: 'unsubscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'hello'));
    expect(socket.sent).toHaveLength(0);
  });

  test('delivers session-scoped events only to subscribers', () => {
    const hub = registerSocket();
    const subscriber = createMockSocket();
    const other = createMockSocket();
    hub.attach(subscriber);
    hub.attach(other);
    hub.handleClientMessage(subscriber, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });

    hub.broadcast(createEvent('runtime.restored', {}, { project_id: 'p1', session_id: 's1' }));
    expect(subscriber.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  test('delivers control-plane session events to all sockets even without subscription', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);

    hub.broadcast(createEvent('session.archived', { session_id: 's1' }, { project_id: 'p1', session_id: 's1' }));
    hub.broadcast(createEvent('session.created', { session_id: 's2' }, { project_id: 'p1', session_id: 's2' }));
    const messages = socket.sent.map((raw) => JSON.parse(raw) as { kind: string; type: string });
    expect(messages).toHaveLength(2);
    expect(messages.filter((msg) => msg.type === 'session.archived')).toHaveLength(1);
    expect(messages.filter((msg) => msg.type === 'session.created')).toHaveLength(1);
  });

  test('delivers terminal messages only to sockets subscribed to the terminal session', () => {
    const hub = registerSocket();
    const subscriber = createMockSocket();
    const other = createMockSocket();
    hub.attach(subscriber);
    hub.attach(other);
    hub.handleClientMessage(subscriber, { kind: 'client', type: 'subscribe_session', payload: { session_id: 'term-1' } });

    hub.broadcast({ kind: 'terminal', type: 'terminal_output', payload: { sessionId: 'term-1', data: 'out' } });
    expect(subscriber.sent).toHaveLength(1);
    expect(other.sent).toHaveLength(0);
  });

  test('sendToSession ignores the sessionId argument and filters by message content', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);

    // 未订阅 → chat_stream 不投递（即使 sessionId 参数匹配）
    hub.sendToSession('s9', createChatStreamFrame('s9', 'complete', 'stream_9', 'msg_9'));
    expect(socket.sent).toHaveLength(0);
  });

  test('detach removes socket and its subscriptions', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.detach(socket);
    // detach 后 broadcast 不应抛错也不应投递
    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'x'));
    expect(socket.sent).toHaveLength(0);
  });
});
