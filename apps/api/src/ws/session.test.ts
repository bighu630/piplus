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
  test('broadcasts chat streams regardless of client tab context', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.setContext(socket, { session_id: 'session_1', current_tab: 'session_info' });

    // chat_stream 现在无条件广播，由前端自行按 session_id / tab 过滤
    hub.sendToSession('session_1', createChatStreamFrame('session_1', 'delta', 'stream_1', 'msg_1', 'hello'));
    expect(socket.sent).toHaveLength(1);
  });

  test('broadcasts chat streams to all connected sockets regardless of session context', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.setContext(socket, { session_id: 'session_2', current_tab: 'chat' });

    // chat_stream 现在无条件广播，由前端自行按 session_id 过滤
    hub.sendToSession('session_1', createChatStreamFrame('session_1', 'delta', 'stream_1', 'msg_1', 'hello'));
    expect(socket.sent).toHaveLength(1);
  });

  test('broadcasts event messages even when no context is set', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);

    hub.broadcast(createEvent('tree.changed', { project_id: 'project_1' }, { project_id: 'project_1' }));
    expect(socket.sent).toHaveLength(1);
  });

  test('still delivers event messages in session_info mode', () => {
    const hub = registerSocket();
    const socket = createMockSocket();
    hub.attach(socket);
    hub.setContext(socket, { session_id: 'session_1', current_tab: 'session_info' });

    hub.sendToSession('session_1', createEvent('session.runtime_status_changed', { runtime_status: 'running' }, { session_id: 'session_1' }));
    expect(socket.sent).toHaveLength(1);
  });
});
