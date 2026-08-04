import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { settings } from '@piplus/db/schema';
import { getDbPath } from '../db-context';

// 允许通过 API 读写的设置项白名单
const ALLOWED_KEYS: readonly string[] = ['subagent_timeout_minutes'];

// 严格校验：非负整数分钟（0 = 永不超时）。
// 拒绝 true→1、null→0、"1e3"→1000、"0x10"→16 等宽松隐式转换。
const isNonNegInt = (raw: unknown): boolean =>
  (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) ||
  (typeof raw === 'string' && /^\d+$/.test(raw.trim()));

// 存储时统一为 String 形式（Number 30 → '30'；字符串 '30' → '30'）
function normalizeValue(raw: number | string): string {
  return typeof raw === 'number' ? String(raw) : raw.trim();
}

export function registerSettingsRoutes(app: Hono) {

  // 读取全部设置，返回平铺 key-value 对象（如 { "subagent_timeout_minutes": "0" }）
  app.get('/api/v1/settings', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const rows = await db.select().from(settings);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return c.json(result);
  });

  // 部分更新设置：白名单校验 + 值校验（非负整数分钟），通过后逐 key upsert
  app.put('/api/v1/settings', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // 先全量校验（白名单 + 值），任一非法立即 400 且不写入任何行；
    // 全部通过后再统一 upsert。
    const entries: Array<[string, string]> = [];
    for (const [key, raw] of Object.entries(body)) {
      if (!ALLOWED_KEYS.includes(key)) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: `未知设置项: ${key}` } }, 400);
      }
      if (!isNonNegInt(raw)) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: 'subagent_timeout_minutes 必须是非负整数分钟（0 = 永不超时）' } }, 400);
      }
      entries.push([key, normalizeValue(raw as number | string)]);
    }

    const now = new Date();
    for (const [key, value] of entries) {
      await db
        .insert(settings)
        .values({ key, value, updatedAt: now })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value, updatedAt: now },
        });
    }

    // 返回更新后的完整平铺对象
    const rows = await db.select().from(settings);
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return c.json(result);
  });
}
