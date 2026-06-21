import type { PiSessionStreamEvent } from '@piplus/pi-client';
import { createChatStreamFrame } from '../ws/protocol';

export function mapPiStreamEventToFrames(
  sessionId: string,
  event: PiSessionStreamEvent,
) {
  switch (event.type) {
    case 'message_start':
      return [createChatStreamFrame(sessionId, 'start', event.runId, event.messageId ?? event.runId)];
    case 'text_delta':
      return [createChatStreamFrame(sessionId, 'delta', event.runId, event.messageId ?? event.runId, event.delta)];
    case 'message_end':
      return [createChatStreamFrame(sessionId, 'complete', event.runId, event.messageId ?? event.runId)];
    case 'error':
      return [createChatStreamFrame(sessionId, 'error', event.runId, event.messageId ?? event.runId, null, event.error)];
  }
}
