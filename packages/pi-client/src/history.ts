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

function decodeCursor(cursor: string | null | undefined, total: number) {
  if (!cursor) return total;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isFinite(value) || value <= 0) return total;
  return Math.min(value, total);
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

  const end = decodeCursor(cursor, messages.length);
  const start = Math.max(end - limit, 0);
  const page = messages.slice(start, end);
  const nextCursor = start > 0 ? String(start) : null;

  return {
    messages: page,
    nextCursor,
  };
}
