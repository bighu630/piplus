import { createSeedDb } from '@piplus/db/init';

export function getDbPath() {
  const envUrl = Bun.env.DATABASE_URL ?? 'file:./piplus.sqlite';
  return envUrl.startsWith('file:') ? envUrl.slice('file:'.length) : envUrl;
}

export function ensureSeedDb() {
  createSeedDb(getDbPath());
}
