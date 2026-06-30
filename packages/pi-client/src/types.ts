import type { PiSessionLocator } from './locator';

export type PiMessageRole = 'user' | 'assistant' | 'system' | 'tool';

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
  model?: {
    provider: string;
    id: string;
  };
};

export type PiCreateSessionResult = {
  sessionId: string;
  locator: PiSessionLocator;
  model?: { provider: string; id: string; label: string };
};

export type PiImageInput = {
  dataBase64: string;
  mediaType?: string;
  mimeType?: string;
  filename?: string;
};

export type PiTextContentBlock = {
  type: 'text';
  text: string;
};

export type PiImageContentBlock = {
  type: 'image';
  mimeType: string | null;
  mediaType: string | null;
  filename: string | null;
  uri: string | null;
  dataBase64: string | null;
};

export type PiContentBlock = PiTextContentBlock | PiImageContentBlock;

export type PiHistoryMessage = {
  id: string;
  role: PiMessageRole;
  text: string;
  createdAt: string | null;
  contentBlocks?: PiContentBlock[];
  messageKind?: 'normal' | 'tool_call' | 'tool';
  toolName?: string;
  toolArgs?: Record<string, unknown>;
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
  | { type: 'error'; sessionId: string; runId: string; messageId?: string; error: string }
  | { type: 'compaction_start'; sessionId: string; reason: 'manual' | 'threshold' | 'overflow' }
  | { type: 'compaction_end'; sessionId: string; reason: 'manual' | 'threshold' | 'overflow'; aborted: boolean; errorMessage?: string };

export type PiContextUsage = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

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
  restoreRuntime(sessionId: string, locator: PiSessionLocator, cwd?: string): Promise<void>;
  subscribeSession(sessionId: string, listener: (event: PiSessionStreamEvent) => void | Promise<void>): Promise<() => void>;
  getHistory(sessionId: string, locator: PiSessionLocator, cursor?: string | null, limit?: number): Promise<PiHistoryPage>;
  sendMessage(sessionId: string, content: string, options?: { images?: PiImageInput[] }): Promise<PiRunAccepted>;
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
  getContextUsage(sessionId: string, locator: PiSessionLocator): Promise<PiContextUsage | null>;
  compactSession(sessionId: string, locator: PiSessionLocator, cwd?: string): Promise<void>;
  registerTools?(tools: PiToolDef[]): Promise<void>;

  /**
   * Dynamically register a custom provider with Pi's model registry.
   * This makes the provider and its models available for use in sessions
   * without writing to Pi's models.json file.
   */
  registerProvider?(providerName: string, config: {
    api: string;
    baseUrl: string;
    apiKey: string;
    authHeader?: boolean;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
    models: Array<{
      id: string;
      name?: string;
      api?: string;
      baseUrl?: string;
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
      input?: string[];
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      contextWindow?: number;
      maxTokens?: number;
      headers?: Record<string, string>;
      compat?: Record<string, unknown>;
    }>;
  }): Promise<void>;

  /**
   * Set an API key for a given provider in auth storage.
   */
  setProviderApiKey?(provider: string, apiKey: string): Promise<void>;

  /**
   * Remove the stored API key for a given provider.
   */
  removeProviderApiKey?(provider: string): Promise<void>;

  /**
   * Get the authentication status for a given provider.
   */
  getProviderAuthStatus?(provider: string): Promise<{ configured: boolean; source?: string; label?: string }>;
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

