import type { ClientMessage, ServerMessage } from '@piplus/shared/ws';
import { isClientMessage } from '@piplus/shared/ws';

export { isClientMessage };

export function parseClientMessage(raw: string): ClientMessage | null {
  try {
    const parsed = JSON.parse(raw);
    return isClientMessage(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function createEvent(type: string, payload: Record<string, unknown>, scope?: { project_id?: string; session_id?: string }): ServerMessage {
  return {
    kind: 'event',
    type,
    timestamp: new Date().toISOString(),
    payload,
    scope,
  };
}

export function createChatStreamFrame(
  sessionId: string,
  phase: 'start' | 'delta' | 'complete' | 'error',
  streamId: string,
  messageId: string,
  delta?: string | null,
  error?: string | null,
): ServerMessage {
  return {
    kind: 'chat_stream',
    phase,
    timestamp: new Date().toISOString(),
    scope: { session_id: sessionId },
    payload: {
      stream_id: streamId,
      message_id: messageId,
      delta: delta ?? null,
      blocks: null,
      error: error ?? null,
    },
  };
}
