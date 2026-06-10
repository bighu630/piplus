export type PiMessageRole = 'user' | 'assistant' | 'system';

export type PiToolDef = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

// PI layer should only see already-compiled session startup data.
export type PiCreateSessionInput = {
  title?: string;
  prompt: string;
  tools?: PiToolDef[];
  metadata?: Record<string, unknown>;
};

export type PiCreateSessionResult = {
  sessionId: string;
};

export type PiMessage = {
  id: string;
  role: PiMessageRole;
  text: string;
};

export type PiListMessagesResult = {
  messages: PiMessage[];
  nextCursor: string | null;
};

export type PiChatResult = {
  sessionId: string;
  messageId: string;
  status: 'accepted';
};

export type PiStopSessionResult = {
  status: 'stopped';
};

export type PiToolCallContext = {
  sessionId: string;
  userId?: string | null;
};

export type PiToolCallHandler = (
  toolName: string,
  args: Record<string, unknown>,
  context: PiToolCallContext,
) => Promise<unknown>;

export type PiStreamEvent = {
  type: string;
  payload: Record<string, unknown>;
};

export type PiStreamChunk = {
  phase: 'start' | 'delta' | 'complete' | 'error';
  messageId?: string;
  delta?: string | null;
  error?: string | null;
  blocks?: unknown[] | null;
};

export type PiClient = {
  createSession(input: PiCreateSessionInput): Promise<PiCreateSessionResult>;
  listMessages(sessionId: string, cursor?: string | null, limit?: number): Promise<PiListMessagesResult>;
  sendMessage(sessionId: string, content: string): Promise<PiChatResult>;
  stopSession(sessionId: string): Promise<PiStopSessionResult>;
  registerTools?(tools: PiToolDef[]): Promise<void>;
};

export type PiRealtimeCapableClient = PiClient & {
  registerToolRuntime?(tools: PiToolDef[], handler: PiToolCallHandler): Promise<void>;
  streamMessage?(
    sessionId: string,
    content: string,
    handlers: {
      onChunk: (chunk: PiStreamChunk) => Promise<void> | void;
      onEvent?: (event: PiStreamEvent) => Promise<void> | void;
    },
  ): Promise<PiChatResult>;
};
