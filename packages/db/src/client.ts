import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { schema } from './schema';

export function createDb(databaseUrl = Bun.env.DATABASE_URL ?? 'file:./piplus.sqlite') {
  const path = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  const sqlite = new Database(path, { create: true });
  return drizzle(sqlite, { schema });
}
