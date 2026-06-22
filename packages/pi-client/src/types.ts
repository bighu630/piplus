import type { PiSessionLocator } from './locator';

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
  cwd?: string;
};

export type PiCreateSessionResult = {
  sessionId: string;
  locator: PiSessionLocator;
  model?: { provider: string; id: string; label: string };
};

export type PiHistoryMessage = {
  id: string;
  role: PiMessageRole;
  text: string;
  createdAt: string | null;
};

export type PiHistoryPage = {
  messages: PiHistoryMessage[];
  nextCursor: string | null;
};

export type PiRunAccepted = {
  sessionId: string;
  runId: string;
};

export type PiModelInfo = {
  provider: string;
  id: string;
  label: string;
};

export type PiSessionStreamEvent =
  | { type: 'message_start'; sessionId: string; runId: string; messageId?: string }
  | { type: 'text_delta'; sessionId: string; runId: string; messageId?: string; delta: string }
  | { type: 'message_end'; sessionId: string; runId: string; messageId?: string }
  | { type: 'error'; sessionId: string; runId: string; messageId?: string; error: string };

export type PiMessage = {
  id: string;
  role: PiMessageRole;
  text: string;
};

export type PiStopSessionResult = {
  status: 'stopped';
};

export type PiClient = {
  createSession(input: PiCreateSessionInput): Promise<PiCreateSessionResult>;
  restoreRuntime(sessionId: string, locator: PiSessionLocator, cwd?: string, modelOverride?: { provider: string; id: string; label?: string }): Promise<void>;
  subscribeSession(sessionId: string, listener: (event: PiSessionStreamEvent) => void | Promise<void>): Promise<() => void>;
  getHistory(sessionId: string, locator: PiSessionLocator, cursor?: string | null, limit?: number): Promise<PiHistoryPage>;
  sendMessage(sessionId: string, content: string): Promise<PiRunAccepted>;
  stopSession(sessionId: string): Promise<PiStopSessionResult>;
  closeRuntime(sessionId: string): Promise<void>;
  listAvailableModels(): Promise<PiModelInfo[]>;
  getCurrentModel(sessionId: string): Promise<PiModelInfo | null>;
  setSessionModel(
    sessionId: string,
    locator: PiSessionLocator,
    modelRef: { provider: string; id: string },
    cwd?: string,
  ): Promise<PiModelInfo>;
  bindToolRuntime(
    sessionId: string,
    tools: PiToolDef[],
    handler: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>,
    cwd?: string,
  ): Promise<void>;
  registerTools?(tools: PiToolDef[]): Promise<void>;
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

export type PiRealtimeCapableClient = PiClient;

