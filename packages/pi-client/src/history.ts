import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiHistoryMessage, PiHistoryPage } from './types';
import type { PiSessionLocator } from './locator';

type ContentBlock = {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type SessionMessageEntry = {
  type: string;
  id: string;
  parentId?: string | null;
  timestamp?: string;
  message?: {
    role?: string;
    content?: string | Array<ContentBlock>;
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
  };
};

function decodeCursor(cursor: string | null | undefined, total: number) {
  if (!cursor) return total;
  const value = Number.parseInt(cursor, 10);
  if (!Number.isFinite(value) || value <= 0) return total;
  return Math.min(value, total);
}

function toText(content: string | Array<ContentBlock> | undefined) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('');
}

function isToolCallBlock(block: ContentBlock): block is { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } {
  return block.type === 'toolCall' && typeof block.id === 'string' && typeof block.name === 'string';
}

export function readHistory(locator: PiSessionLocator, cursor?: string | null, limit = 50): PiHistoryPage {
  const manager = SessionManager.open(locator.sessionFile);
  const rawEntries = manager.getEntries() as SessionMessageEntry[];

  const messages: PiHistoryMessage[] = [];

  for (const entry of rawEntries) {
    if (entry.type !== 'message') continue;
    const msg = entry.message;
    if (!msg) continue;

    if (msg.role === 'user') {
      messages.push({
        id: entry.id,
        role: 'user',
        text: toText(msg.content),
        createdAt: entry.timestamp ?? null,
      });
    } else if (msg.role === 'assistant') {
      const content = Array.isArray(msg.content) ? msg.content : [];

      // Emit text portion of the assistant message
      const textContent = content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text!)
        .join('');

      if (textContent) {
        messages.push({
          id: entry.id,
          role: 'assistant',
          text: textContent,
          createdAt: entry.timestamp ?? null,
        });
      }

      // Emit a separate message for each tool call
      const toolCalls = content.filter(isToolCallBlock);
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i];
        messages.push({
          id: `${entry.id}-tool-${i}`,
          role: 'assistant',
          text: '',
          createdAt: entry.timestamp ?? null,
          messageKind: 'tool_call',
          toolName: tc.name,
          toolArgs: tc.arguments ?? {},
        });
      }
    } else if (msg.role === 'toolResult') {
      const toolName = msg.toolName ?? 'unknown';
      const resultText = toText(msg.content);
      const isError = msg.isError === true;

      messages.push({
        id: entry.id,
        role: 'tool',
        text: isError && resultText ? `Error: ${resultText}` : resultText,
        createdAt: entry.timestamp ?? null,
        messageKind: 'tool',
        toolName,
      });
    }
  }

  const end = decodeCursor(cursor, messages.length);
  const start = Math.max(end - limit, 0);
  const page = messages.slice(start, end);
  const nextCursor = start > 0 ? String(start) : null;

  return {
    messages: page,
    nextCursor,
  };
}
