import { describe, expect, test } from 'bun:test';
import { createDb } from '@piplus/db/client';
import { createSeedDb } from '@piplus/db/init';
import { settings } from '@piplus/db/schema';
import { getSetting, getSubagentTimeoutMs, setSetting, SETTING_KEY_SUBAGENT_TIMEOUT } from './service';

function makeDbPath() {
  return `/tmp/piplus-settings-${crypto.randomUUID()}.sqlite`;
}

async function setupDb() {
  const dbPath = makeDbPath();
  createSeedDb(dbPath);
  const db = createDb(`file:${dbPath}`);
  return { db };
}

describe('settings service', () => {
  test('未设置时 getSubagentTimeoutMs 返回 0', async () => {
    const { db } = await setupDb();
    expect(await getSubagentTimeoutMs(db)).toBe(0);
  });

  test("setSetting('30') 后返回 30 * 60 * 1000", async () => {
    const { db } = await setupDb();
    await setSetting(db, SETTING_KEY_SUBAGENT_TIMEOUT, '30');
    expect(await getSubagentTimeoutMs(db)).toBe(30 * 60 * 1000);
  });

  test("非法值（'abc'、'-5'、'1.5'、'NaN'）一律返回 0", async () => {
    const { db } = await setupDb();
    for (const bad of ['abc', '-5', '1.5', 'NaN']) {
      await setSetting(db, SETTING_KEY_SUBAGENT_TIMEOUT, bad);
      expect(await getSubagentTimeoutMs(db)).toBe(0);
    }
  });

  test('setSetting 后 getSetting 能读回', async () => {
    const { db } = await setupDb();
    await setSetting(db, 'some_key', 'some_value');
    expect(await getSetting(db, 'some_key')).toBe('some_value');
    expect(await getSetting(db, 'missing_key')).toBeNull();
  });

  test('upsert 语义：同 key 写两次，第二次覆盖，且只存在一行', async () => {
    const { db } = await setupDb();
    await setSetting(db, SETTING_KEY_SUBAGENT_TIMEOUT, '10');
    await setSetting(db, SETTING_KEY_SUBAGENT_TIMEOUT, '20');
    expect(await getSetting(db, SETTING_KEY_SUBAGENT_TIMEOUT)).toBe('20');

    const rows = await db.select().from(settings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe('20');
  });
});
