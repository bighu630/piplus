const SESSION_DRAFTS_STORAGE_KEY = 'pi-session-drafts-v1';
const SESSION_DRAFT_TTL_MS = 30 * 60 * 1000; // 30 minutes

export { SESSION_DRAFTS_STORAGE_KEY, SESSION_DRAFT_TTL_MS };

interface SessionDraftRecord {
  text: string;
  updatedAt: number;
}

type SessionDraftStore = Record<string, SessionDraftRecord>;

function readStore(): SessionDraftStore {
  try {
    const raw = localStorage.getItem(SESSION_DRAFTS_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as SessionDraftStore;
  } catch {
    return {};
  }
}

function writeStore(store: SessionDraftStore): void {
  try {
    localStorage.setItem(SESSION_DRAFTS_STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/**
 * Remove all expired draft entries from the store.
 */
export function pruneExpiredSessionDrafts(): void {
  const store = readStore();
  const now = Date.now();
  let changed = false;
  for (const sessionId of Object.keys(store)) {
    const record = store[sessionId];
    if (now - record.updatedAt > SESSION_DRAFT_TTL_MS) {
      delete store[sessionId];
      changed = true;
    }
  }
  if (changed) {
    writeStore(store);
  }
}

/**
 * Load the saved draft for the given session.
 * Returns empty string if no valid (non-expired) draft exists.
 */
export function loadSessionDraft(sessionId: string): string {
  if (!sessionId) return '';
  pruneExpiredSessionDrafts();
  const store = readStore();
  const record = store[sessionId];
  if (!record) return '';
  if (Date.now() - record.updatedAt > SESSION_DRAFT_TTL_MS) {
    // Expired — clean up
    delete store[sessionId];
    writeStore(store);
    return '';
  }
  return record.text;
}

/**
 * Save draft text for the given session.
 * If text is empty, the draft entry is removed (same as clear).
 */
export function saveSessionDraft(sessionId: string, text: string): void {
  if (!sessionId) return;
  const store = readStore();
  if (text) {
    store[sessionId] = { text, updatedAt: Date.now() };
  } else {
    // Empty text → clear the draft
    delete store[sessionId];
  }
  writeStore(store);
}

/**
 * Remove the draft entry for the given session entirely.
 */
export function clearSessionDraft(sessionId: string): void {
  if (!sessionId) return;
  const store = readStore();
  delete store[sessionId];
  writeStore(store);
}
