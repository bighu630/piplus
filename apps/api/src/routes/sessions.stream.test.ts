import { describe, expect, test } from 'bun:test';
import { mapPiStreamEventToFrames } from '../lib/pi-stream-bridge';

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
});
