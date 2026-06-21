import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiHistoryMessage, PiHistoryPage } from './types';
import type { PiSessionLocator } from './locator';

type SessionMessageEntry = {
  type: string;
  id: string;
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
  };
  timestamp?: string;
};

function decodeCursor(cursor: string | null | undefined) {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function toText(content: string | Array<{ type?: string; text?: string }> | undefined) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

export function readHistory(locator: PiSessionLocator, cursor?: string | null, limit = 50): PiHistoryPage {
  const manager = SessionManager.open(locator.sessionFile);
  const entries = manager.getEntries() as SessionMessageEntry[];
  const messages: PiHistoryMessage[] = entries
    .filter((entry) => entry.type === 'message')
    .filter((entry) => entry.message?.role === 'user' || entry.message?.role === 'assistant')
    .map((entry) => ({
      id: entry.id,
      role: entry.message?.role as PiHistoryMessage['role'],
      text: toText(entry.message?.content),
      createdAt: entry.timestamp ?? null,
    }));

  const offset = decodeCursor(cursor);
  const page = messages.slice(offset, offset + limit);
  const nextCursor = offset + page.length < messages.length ? String(offset + page.length) : null;

  return {
    messages: page,
    nextCursor,
  };
}
