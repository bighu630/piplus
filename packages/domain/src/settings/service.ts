import { eq } from 'drizzle-orm';
import { settings } from '@piplus/db/schema';
import type { RoleManagerDb } from '../role-manager/service';

export const SETTING_KEY_SUBAGENT_TIMEOUT = 'subagent_timeout_minutes';

/** 读取设置值，不存在返回 null。 */
export async function getSetting(db: RoleManagerDb, key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value ?? null;
}

/** 写入设置值（upsert，updatedAt = now）。 */
export async function setSetting(db: RoleManagerDb, key: string, value: string): Promise<void> {
  const updatedAt = new Date();
  await db
    .insert(settings)
    .values({ key, value, updatedAt })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt } });
}

/** 读取子代理超时时间（毫秒）。语义：0 = 永不超时。非法值（非正整数/负数）一律按 0 处理。每次调用实时读库。 */
export async function getSubagentTimeoutMs(db: RoleManagerDb): Promise<number> {
  const raw = await getSetting(db, SETTING_KEY_SUBAGENT_TIMEOUT);
  if (raw === null || raw.trim() === '') return 0;
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes < 0) return 0;
  return minutes * 60 * 1000;
}
