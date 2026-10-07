import { describe, expect, test } from 'bun:test';
import { mapPiStreamEventToFrames } from '../lib/pi-stream-bridge';
import { socketHub } from '../ws/server';
import { forwardPiStreamEventToSubscribers } from './sessions/routes/chat';

function createMockSocket() {
  return {
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

describe('pi stream bridge', () => {
  test('maps text deltas to chat stream frames', () => {
    const frames = mapPiStreamEventToFrames('session_1', {
      type: 'text_delta',
      sessionId: 'session_1',
      runId: 'run_1',
      messageId: 'msg_1',
      delta: 'hello',
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'chat_stream',
      phase: 'delta',
      scope: { session_id: 'session_1' },
      payload: {
        stream_id: 'run_1',
        message_id: 'msg_1',
        delta: 'hello',
        error: null,
      },
    });
  });

  test('maps tool result end to a lightweight messages-changed event (not chat_stream)', () => {
    const frames = mapPiStreamEventToFrames('session_1', {
      type: 'tool_result_end',
      sessionId: 'session_1',
      runId: 'run_1',
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'event',
      type: 'session.messages_changed',
      scope: { session_id: 'session_1' },
    });
  });

  /**
   * R1/R2 回归：domain 内发起的 run（spawn 的子会话、writeback auto-wake 的父会话）在平台侧
   * 复用同一个 onStreamEvent 回调，事件里的 sessionId 与「发起该回调的路由会话」不同。
   * 转发必须按 event.sessionId 路由——用发起 run 的闭包 sessionId 会把子会话的流文本
   * 打进父会话的流式快照（前端按 scope.session_id 归档），比「没有事件」更糟。
   */
  test('domain 内发起的 run：流事件按 event.sessionId 投递给订阅者，不会串到发起会话', () => {
    // 订阅归属校验默认按 APP_PASSWORD 开关：测试只需要 mock socket 能订阅，
    // 因此临时关闭认证（与 ws/server.test.ts 同模式），finally 恢复。
    const previousPassword = Bun.env.APP_PASSWORD;
    delete Bun.env.APP_PASSWORD;
    const parentSocket = createMockSocket();
    const childSocket = createMockSocket();
    socketHub.attach(parentSocket);
    socketHub.attach(childSocket);
    try {
      socketHub.handleClientMessage(parentSocket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 'session_parent' } });
      socketHub.handleClientMessage(childSocket, { kind: 'client', type: 'subscribe_session', payload: { session_id: 'session_child' } });

      // 模拟「父会话发起 spawn → 子会话 run 发流事件」：事件 sessionId 是子会话
      forwardPiStreamEventToSubscribers({ type: 'text_delta', sessionId: 'session_child', runId: 'run_1', messageId: 'msg_1', delta: 'child text' });

      const childFrames = childSocket.sent.map((raw) => JSON.parse(raw) as { kind: string; phase?: string; scope?: { session_id?: string }; payload?: { delta?: string } });
      expect(childFrames).toHaveLength(1);
      expect(childFrames[0]).toMatchObject({
        kind: 'chat_stream',
        phase: 'delta',
        scope: { session_id: 'session_child' },
        payload: { delta: 'child text' },
      });
      // 父会话未订阅子会话 → 不得收到子会话的帧
      expect(parentSocket.sent).toHaveLength(0);
    } finally {
      socketHub.detach(parentSocket);
      socketHub.detach(childSocket);
      if (previousPassword === undefined) delete Bun.env.APP_PASSWORD;
      else Bun.env.APP_PASSWORD = previousPassword;
    }
  });
});
