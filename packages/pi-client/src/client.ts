import type {
  PiChatResult,
  PiClient,
  PiCreateSessionResult,
  PiListMessagesResult,
  PiMessage,
  PiToolDef,
} from './types';

type InMemoryPiSession = {
  messages: PiMessage[];
  stopped: boolean;
  prompt: string;
  title: string | null;
};

const sessions = new Map<string, InMemoryPiSession>();

function getOrCreateSession(sessionId: string) {
  const existing = sessions.get(sessionId);
  if (existing) return existing;
  const created: InMemoryPiSession = { messages: [], stopped: false, prompt: '', title: null };
  sessions.set(sessionId, created);
  return created;
}

function decodeCursor(cursor: string | null | undefined) {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createPiClient(): PiClient {
  return {
    async createSession(input): Promise<PiCreateSessionResult> {
      const sessionId = `pi_${crypto.randomUUID().slice(0, 12)}`;
      sessions.set(sessionId, {
        messages: [],
        stopped: false,
        prompt: input.prompt,
        title: input.title ?? null,
      });
      return { sessionId };
    },
    async listMessages(sessionId, cursor, limit = 50): Promise<PiListMessagesResult> {
      const session = getOrCreateSession(sessionId);
      const offset = decodeCursor(cursor);
      const page = session.messages.slice(offset, offset + limit);
      const nextCursor = offset + page.length < session.messages.length ? String(offset + page.length) : null;
      return { messages: page, nextCursor };
    },
    async sendMessage(sessionId, content): Promise<PiChatResult> {
      const session = getOrCreateSession(sessionId);
      const userMessage: PiMessage = { id: `pi_msg_${crypto.randomUUID().slice(0, 10)}`, role: 'user', text: content };
      const assistantMessage: PiMessage = { id: `pi_msg_${crypto.randomUUID().slice(0, 10)}`, role: 'assistant', text: content };
      session.stopped = false;
      session.messages.push(userMessage, assistantMessage);
      return { sessionId, messageId: assistantMessage.id, status: 'accepted' };
    },
    async stopSession(sessionId) {
      const session = getOrCreateSession(sessionId);
      session.stopped = true;
      return { status: 'stopped' as const };
    },
    async registerTools(_tools: PiToolDef[]) {
      // Stub: tools are registered in-memory only.
      // Real PI SDK adapter will register tools with the PI agent runtime.
    },
  };
}
