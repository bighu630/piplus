import { request } from './client';
import type {
  SessionInfoDTO,
  SessionContextUsageDTO,
  ChatMessageDTO,
  ChatImageContentBlockDTO,
} from '@piplus/shared';

export type SessionMessagesPage = {
  session_id: string;
  cursor: string | null;
  next_cursor: string | null;
  messages: ChatMessageDTO[];
};

export function getSessionInfo(sessionId: string) {
  return request<SessionInfoDTO>(`/api/v1/sessions/${sessionId}/info`);
}

export function getSessionMessages(sessionId: string, options?: { cursor?: string | null; limit?: number }) {
  const params = new URLSearchParams();
  if (options?.cursor) params.set('cursor', options.cursor);
  if (options?.limit) params.set('limit', String(options.limit));
  const query = params.toString();
  return request<SessionMessagesPage>(`/api/v1/sessions/${sessionId}/chat/messages${query ? `?${query}` : ''}`);
}

export function getPlannerRolePrompt(sessionId: string) {
  return request<{ session_id: string; prompt: string; prompt_length: number }>(`/api/v1/sessions/${sessionId}/planner-role-prompt`);
}

export type SessionMessageImageAttachment = {
  type: 'image';
  mime_type: string;
  data_base64: string;
  filename?: string | null;
};

export type SendSessionMessagePayload = {
  content: string;
  attachments?: SessionMessageImageAttachment[];
};

export type OptimisticImageContentBlock = ChatImageContentBlockDTO;

export function sendSessionMessage(sessionId: string, payload: SendSessionMessagePayload) {
  return request<{ accepted: boolean; session_id: string; run_id?: string; message_id?: string; steered?: boolean; queued?: number }>(
    `/api/v1/sessions/${sessionId}/chat/messages`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

export function stopSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/stop`, { method: 'POST' });
}

export function setSessionPinned(sessionId: string, pinned: boolean) {
  return request<{ session_id: string; title: string; title_source: string; pinned_at: string | null }>(`/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ pinned }),
  });
}

export function archiveSession(sessionId: string) {
  return request<{ session_id: string; status: string }>(`/api/v1/sessions/${sessionId}/archive`, { method: 'POST' });
}

export function updateSessionTitle(sessionId: string, title: string) {
  return request<{ session_id: string; title: string; title_source: string }>(`/api/v1/sessions/${sessionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export type CommandInfo = {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
};

export function getSessionCommands(sessionId: string) {
  return request<{ commands: CommandInfo[] }>(`/api/v1/sessions/${sessionId}/commands`);
}

export function restoreSessionRuntime(sessionId: string) {
  return request<{ session_id: string; accepted: boolean }>(`/api/v1/sessions/${sessionId}/restore-runtime`, {
    method: 'POST',
  });
}

export function getSessionContextUsage(sessionId: string) {
  return request<SessionContextUsageDTO>(`/api/v1/sessions/${sessionId}/context-usage`);
}

export function compactSession(sessionId: string) {
  return request<{ session_id: string; accepted: boolean }>(`/api/v1/sessions/${sessionId}/compact`, {
    method: 'POST',
  });
}
