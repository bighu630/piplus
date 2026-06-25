import type { PiSessionStreamEvent } from '@piplus/pi-client';
import { createChatStreamFrame, createEvent } from '../ws/protocol';

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
    case 'compaction_start':
      return [createEvent('session.compaction_start', { reason: event.reason }, { session_id: sessionId })];
    case 'compaction_end':
      return [createEvent('session.compaction_end', { reason: event.reason, aborted: event.aborted, error_message: event.errorMessage ?? null }, { session_id: sessionId })];
  }
}
