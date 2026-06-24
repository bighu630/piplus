import { createSeedDb } from '@piplus/db/init';
import { createDb } from '@piplus/db/client';
import { sessions } from '@piplus/db/schema';
import { ne } from 'drizzle-orm';
import { getDatabasePath } from './server-config';

export function getDbPath() {
  return getDatabasePath();
}

export function ensureSeedDb() {
  createSeedDb(getDbPath());
}

export function recoverStuckSessions() {
  try {
    const db = createDb(`file:${getDbPath()}`);
    const now = new Date();
    db.update(sessions)
      .set({ runtimeStatus: 'idle', lastRuntimeError: 'recovered_after_restart', updatedAt: now })
      .where(ne(sessions.runtimeStatus, 'idle'))
      .run();
  } catch { /* ignore if table doesn't exist yet */ }
}
