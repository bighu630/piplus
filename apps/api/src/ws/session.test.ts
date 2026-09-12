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

/** 给 mock socket 打上认证握手写入的 __userId，模拟已认证连接。 */
function withUser<T extends object>(socket: T, userId: string): T {
  return Object.assign(socket, { __userId: userId });
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

  // ===== sendToUser：ask_question 跨会话通知的数据通路 =====
  // 前端任何时刻只订阅当前激活会话，旧的 sendToSession 会让切走后的提问通知丢失；
  // sendToUser 按登录用户投递且不受订阅限制，同时仍隔离其他用户。

  test('sendToUser reaches every connection of that user even without a subscription', () => {
    const hub = registerSocket();
    const subscribed = withUser(createMockSocket(), 'u1');
    const unsubscribed = withUser(createMockSocket(), 'u1');
    const otherUser = withUser(createMockSocket(), 'u2');
    hub.attach(subscribed);
    hub.attach(unsubscribed);
    hub.attach(otherUser);
    hub.handleClientMessage(subscribed, {
      kind: 'client',
      type: 'subscribe_session',
      payload: { session_id: 's1' },
    });

    hub.sendToUser('u1', createEvent('ask_question_pending', { questionId: 'q1' }, { session_id: 's1' }));

    expect(subscribed.sent).toHaveLength(1); // 已订阅 → 收到
    expect(unsubscribed.sent).toHaveLength(1); // 未订阅 → 也收到（本次修复的核心）
    expect(otherUser.sent).toHaveLength(0); // 跨用户 → 不泄露
  });

  test('sendToUser with empty userId delivers nothing (no broadcast to anonymous sockets)', () => {
    const hub = registerSocket();
    const anonymous = createMockSocket(); // 未认证连接没有 __userId
    hub.attach(anonymous);

    hub.sendToUser('', createEvent('ask_question_pending', { questionId: 'q1' }, { session_id: 's1' }));

    expect(anonymous.sent).toHaveLength(0);
  });
});

describe('ws session hub with authorizeSubscribe (H2)', () => {
  function createHub(authorize: (ws: unknown, sessionId: string) => boolean) {
    return registerSocket({ authorizeSubscribe: authorize });
  }

  test('denied subscribe does not join the subscription set and replies subscription.denied', () => {
    const hub = createHub((_ws, sessionId) => sessionId !== 's-private');
    const socket = createMockSocket();
    hub.attach(socket);

    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's-private' } });

    // 回发拒绝事件
    expect(socket.sent).toHaveLength(1);
    const denied = JSON.parse(socket.sent[0]!) as { kind: string; type: string; payload: { session_id: string } };
    expect(denied.type).toBe('subscription.denied');
    expect(denied.payload.session_id).toBe('s-private');

    // 未加入订阅集合：会话私有事件不投递
    hub.sendToSession('s-private', createChatStreamFrame('s-private', 'delta', 'stream_1', 'msg_1', 'x'));
    expect(socket.sent).toHaveLength(1);
  });

  test('allowed subscribe behaves normally', () => {
    const hub = createHub(() => true);
    const socket = createMockSocket();
    hub.attach(socket);

    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });
    // 无拒绝事件
    expect(socket.sent).toHaveLength(0);

    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'x'));
    expect(socket.sent).toHaveLength(1);
  });

  test('unsubscribe is always allowed even when subscribe would be denied', () => {
    let denyAll = true;
    const hub = registerSocket({ authorizeSubscribe: () => !denyAll });
    const socket = createMockSocket();
    hub.attach(socket);

    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });
    expect(socket.sent).toHaveLength(1); // 被拒

    // 先放行订阅，再收紧策略后取消订阅
    denyAll = false;
    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });
    denyAll = true;
    hub.handleClientMessage(socket, { kind: 'client', type: 'unsubscribe_session', payload: { session_id: 's1' } });

    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_2', 'msg_2', 'x'));
    expect(socket.sent).toHaveLength(1); // 只有拒绝事件，无 chat_stream
  });

  test('no callback injected: subscribe behavior unchanged', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.handleClientMessage(socket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 's1' } });
    hub.sendToSession('s1', createChatStreamFrame('s1', 'delta', 'stream_1', 'msg_1', 'x'));
    expect(socket.sent).toHaveLength(1);
  });
});
