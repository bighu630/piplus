import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { settings } from '@piplus/db/schema';
import { getDbPath } from '../db-context';

// 允许通过 API 读写的设置项白名单
const ALLOWED_KEYS: readonly string[] = ['subagent_timeout_minutes', 'vision_enabled', 'vision_model', 'vision_fallback_model'];

// 严格校验：非负整数分钟（0 = 永不超时）。
// 拒绝 true→1、null→0、"1e3"→1000、"0x10"→16 等宽松隐式转换。
const isNonNegInt = (raw: unknown): boolean =>
  (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) ||
  (typeof raw === 'string' && /^\d+$/.test(raw.trim()));

// 存储时统一为 String 形式（Number 30 → '30'；字符串 '30' → '30'）
function normalizeValue(raw: number | string): string {
  return typeof raw === 'number' ? String(raw) : raw.trim();
}

// 模型引用格式：provider/id（id 内可含 '/'，如 custom-provider/models/xxx）
const MODEL_REF_PATTERN = /^[^/\s]+\/.+$/;

/** 返回规范化后的存储值；返回 null 表示校验失败（message 中有原因）。空字符串表示清除配置。 */
function validateSettingValue(key: string, raw: unknown): { ok: true; value: string } | { ok: false; message: string } {
  switch (key) {
    case 'subagent_timeout_minutes': {
      if (!isNonNegInt(raw)) {
        return { ok: false, message: 'subagent_timeout_minutes 必须是非负整数分钟（0 = 永不超时）' };
      }
      return { ok: true, value: normalizeValue(raw as number | string) };
    }
    case 'vision_enabled': {
      const s = typeof raw === 'string' ? raw.trim() : String(raw);
      if (s !== 'true' && s !== 'false') {
        return { ok: false, message: 'vision_enabled 必须是 "true" 或 "false"' };
      }
      return { ok: true, value: s };
    }
    case 'vision_model':
    case 'vision_fallback_model': {
      if (typeof raw !== 'string') {
        return { ok: false, message: `${key} 必须是 "provider/id" 格式` };
      }
      const s = raw.trim();
      if (s !== '' && !MODEL_REF_PATTERN.test(s)) {
        return { ok: false, message: `${key} 必须是 "provider/id" 格式` };
      }
      return { ok: true, value: s };
    }
    default:
      return { ok: false, message: `未知设置项: ${key}` };
  }
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
      const result = validateSettingValue(key, raw);
      if (!result.ok) {
        return c.json({ error: { code: 'VALIDATION_ERROR', message: result.message } }, 400);
      }
      entries.push([key, result.value]);
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
