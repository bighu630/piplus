export type ClientHello = {
  kind: 'client';
  type: 'hello';
  payload: { user_agent?: string; token?: string };
};

/** 服务端下发：认证失败/超时未认证（客户端收到后不应重连，应引导重新登录）。 */
export const WS_EVENT_UNAUTHENTICATED = 'connection.unauthenticated';
/** 服务端下发：subscribe_session 归属校验未通过。 */
export const WS_EVENT_SUBSCRIPTION_DENIED = 'subscription.denied';

export type ClientSetContext = {
  kind: 'client';
  type: 'set_context';
  payload: {
    project_id?: string;
    session_id?: string;
    current_tab?: 'chat' | 'session_info' | 'git_diff' | 'files' | 'terminal';
  };
};

export type ClientTerminalStart = {
  kind: 'client';
  type: 'terminal_start';
  payload: {
    sessionId: string;
    cols: number;
    rows: number;
  };
};

export type ClientTerminalInput = {
  kind: 'client';
  type: 'terminal_input';
  payload: {
    sessionId: string;
    data: string;
  };
};

export type ClientTerminalResize = {
  kind: 'client';
  type: 'terminal_resize';
  payload: {
    sessionId: string;
    cols: number;
    rows: number;
  };
};

export type ClientTerminalStop = {
  kind: 'client';
  type: 'terminal_stop';
  payload: {
    sessionId: string;
  };
};

export type ClientPing = {
  kind: 'client';
  type: 'ping';
  payload: { timestamp: string };
};

export type ClientSubscribeSession = {
  kind: 'client';
  type: 'subscribe_session';
  payload: { session_id: string };
};

export type ClientUnsubscribeSession = {
  kind: 'client';
  type: 'unsubscribe_session';
  payload: { session_id: string };
};

export type ClientMessage = ClientHello | ClientSetContext | ClientPing | ClientSubscribeSession | ClientUnsubscribeSession | ClientTerminalStart | ClientTerminalInput | ClientTerminalResize | ClientTerminalStop;

export type EventMessage = {
  kind: 'event';
  type: string;
  timestamp: string;
  scope?: { project_id?: string; session_id?: string };
  payload: Record<string, unknown>;
};

export type TerminalOutputMessage = {
  kind: 'terminal';
  type: 'terminal_output';
  payload: {
    sessionId: string;
    data: string;
  };
};

export type TerminalExitMessage = {
  kind: 'terminal';
  type: 'terminal_exit';
  payload: {
    sessionId: string;
    code: number;
  };
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

export type ServerMessage = EventMessage | ChatStreamMessage | TerminalOutputMessage | TerminalExitMessage;

export function isClientMessage(message: unknown): message is ClientMessage {
  if (!message || typeof message !== 'object') return false;
  const value = message as Partial<ClientMessage> & { kind?: string; type?: string };
  if (value.kind !== 'client') return false;
  const t = value.type;
  return t === 'hello' || t === 'set_context' || t === 'ping' ||
    t === 'subscribe_session' || t === 'unsubscribe_session' ||
    t === 'terminal_start' || t === 'terminal_input' || t === 'terminal_resize' || t === 'terminal_stop';
}
