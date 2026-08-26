import { createLogger } from '../../lib/logger';

export function randomId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 12)}`;
}

type MessageCursor = {
  created_at: string;
  id: string;
};

export function encodeCursor(row: { createdAt: Date; id: string }) {
  const payload: MessageCursor = { created_at: row.createdAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(payload)).toString('base64url');
}

export function decodeCursor(raw: string): MessageCursor | null {
  try {
    const payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<MessageCursor>;
    if (typeof payload.created_at === 'string' && typeof payload.id === 'string') return { created_at: payload.created_at, id: payload.id };
  } catch {
    return null;
  }
  return null;
}

let messageSequence = 0;
export function nextMessageTime() {
  messageSequence += 1;
  return new Date(Date.now() + messageSequence);
}

export const log = createLogger('routes.sessions');

export const MAX_CHAT_IMAGE_ATTACHMENTS = 4;
export const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const IMAGE_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
};
export const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;
