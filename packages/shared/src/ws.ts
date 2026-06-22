export type ClientHello = {
  kind: 'client';
  type: 'hello';
  payload: { user_agent?: string };
};

export type ClientSetContext = {
  kind: 'client';
  type: 'set_context';
  payload: {
    project_id?: string;
    session_id?: string;
    current_tab?: 'chat' | 'session_info' | 'git_diff';
  };
};

export type ClientPing = {
  kind: 'client';
  type: 'ping';
  payload: { timestamp: string };
};

export type ClientMessage = ClientHello | ClientSetContext | ClientPing;

export type EventMessage = {
  kind: 'event';
  type: string;
  timestamp: string;
  scope?: { project_id?: string; session_id?: string };
  payload: Record<string, unknown>;
};

export type ChatStreamMessage = {
  kind: 'chat_stream';
  phase: 'start' | 'delta' | 'complete' | 'error';
  timestamp: string;
  scope: { session_id: string };
  payload: {
    stream_id: string;
    message_id: string;
    delta?: string | null;
    blocks?: unknown[] | null;
    error?: string | null;
  };
};

export type ServerMessage = EventMessage | ChatStreamMessage;

export function isClientMessage(message: unknown): message is ClientMessage {
  if (!message || typeof message !== 'object') return false;
  const value = message as Partial<ClientMessage> & { kind?: string; type?: string };
  return value.kind === 'client' && (value.type === 'hello' || value.type === 'set_context' || value.type === 'ping');
}
