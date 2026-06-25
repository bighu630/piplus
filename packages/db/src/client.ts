import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { schema } from './schema';

function getDefaultDatabaseUrl() {
  const home = Bun.env.HOME ?? process.env.HOME ?? '/tmp';
  return `file:${home}/.config/piplus/piplus.sqlite`;
}

export function createDb(databaseUrl = Bun.env.DATABASE_URL ?? getDefaultDatabaseUrl()) {
  const path = databaseUrl.startsWith('file:') ? databaseUrl.slice('file:'.length) : databaseUrl;
  const sqlite = new Database(path, { create: true });
  return drizzle(sqlite, { schema });
}
