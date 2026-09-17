import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createSeedDb, findMigrationFile, getMigrationFileCandidates } from './init';

const DEV_SRC = '/repo/packages/db/src';
const BUNFS_SRC = '/$bunfs/root/packages/db/src';
const PACKAGED_EXEC = '/repo/resources/bin/piplus-api';
const DIST_EXEC = '/repo/apps/api/dist/piplus-api';

describe('getMigrationFileCandidates 纯路径断言', () => {
  test('dev 布局：importMetaDir 为真实路径（packages/db/src）→ 候选[0] 指向 packages/db/migrations', () => {
    const candidates = getMigrationFileCandidates(DEV_SRC, PACKAGED_EXEC);
    expect(candidates[0]).toBe('/repo/packages/db/migrations/0001_initial.sql');
    expect(candidates[0]).toBe(join(DEV_SRC, '../migrations/0001_initial.sql'));
  });

  test('打包布局：importMetaDir 为虚拟 /$bunfs/root → 候选[3] 指向 resources/migrations', () => {
    const candidates = getMigrationFileCandidates(BUNFS_SRC, PACKAGED_EXEC);
    expect(candidates[3]).toBe('/repo/resources/migrations/0001_initial.sql');
    expect(candidates[3]).toBe(join(dirname(PACKAGED_EXEC), '../migrations/0001_initial.sql'));
  });

  test('直跑布局：产物在 apps/api/dist 直接运行 → 候选[4] 指向 apps/migrations', () => {
    const candidates = getMigrationFileCandidates(BUNFS_SRC, DIST_EXEC);
    expect(candidates[4]).toBe('/repo/apps/migrations/0001_initial.sql');
  });
});

describe('findMigrationFile 集成断言', () => {
  test('打包布局：resources/migrations/0001_initial.sql 存在时返回该文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'piplus-db-init-'));
    try {
      mkdirSync(join(root, 'resources', 'bin'), { recursive: true });
      mkdirSync(join(root, 'resources', 'migrations'), { recursive: true });
      const expected = join(root, 'resources', 'migrations', '0001_initial.sql');
      writeFileSync(expected, '-- test migration');
      const execPath = join(root, 'resources', 'bin', 'piplus-api');
      expect(findMigrationFile(BUNFS_SRC, execPath)).toBe(expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('文件缺失时抛错并列出候选路径', () => {
    const root = mkdtempSync(join(tmpdir(), 'piplus-db-init-'));
    try {
      const execPath = join(root, 'resources', 'bin', 'piplus-api');
      expect(() => findMigrationFile(BUNFS_SRC, execPath)).toThrow(/migration file not found/);
      expect(() => findMigrationFile(BUNFS_SRC, execPath)).toThrow(/searched:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('ensureBuiltinRows 内置 upsert、用户行不动', () => {
  type RoleRow = Record<string, unknown>;

  function seedFreshDb() {
    const dir = mkdtempSync(join(tmpdir(), 'piplus-db-seed-'));
    const dbPath = join(dir, 'test.sqlite');
    createSeedDb(dbPath);
    return { dir, dbPath };
  }

  function readRoles(dbPath: string): RoleRow[] {
    const sqlite = new Database(dbPath, { readonly: true });
    try {
      return sqlite.prepare('SELECT * FROM role_templates ORDER BY id').all() as RoleRow[];
    } finally {
      sqlite.close();
    }
  }

  function writeDb(dbPath: string, fn: (sqlite: Database) => void) {
    const sqlite = new Database(dbPath);
    try {
      fn(sqlite);
    } finally {
      sqlite.close();
    }
  }

  test('messages writeback 回扫索引在既有 DB 上也会被补齐（0008）', () => {
    // 既有 DB：先建库并删掉索引，模拟「升级前创建的库」，再跑一次 createSeedDb
    const { dir, dbPath } = seedFreshDb();
    try {
      writeDb(dbPath, (sqlite) => {
        sqlite.exec('DROP INDEX IF EXISTS idx_messages_session_kind_time');
        const dropped = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_messages_session_kind_time'").all();
        expect(dropped).toHaveLength(0);
      });

      createSeedDb(dbPath);

      writeDb(dbPath, (sqlite) => {
        const rows = sqlite
          .prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND name='idx_messages_session_kind_time'")
          .all() as Array<{ name: string; sql: string }>;
        expect(rows).toHaveLength(1);
        // 列顺序即回扫查询的过滤条件顺序（findStrandedWritebacks / findUnconsumedWritebacks）
        expect(rows[0].sql).toContain('messages(session_id, message_kind, created_at)');
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // 新逻辑无条件同步，不依赖开关：显式清空开关以证明这一点。
  function withoutForceFlag(fn: () => void) {
    const savedBun = Bun.env.PIPLUS_FORCE_ROLE_PROMPTS;
    const savedProcess = process.env.PIPLUS_FORCE_ROLE_PROMPTS;
    delete Bun.env.PIPLUS_FORCE_ROLE_PROMPTS;
    delete process.env.PIPLUS_FORCE_ROLE_PROMPTS;
    try {
      fn();
    } finally {
      if (savedBun !== undefined) Bun.env.PIPLUS_FORCE_ROLE_PROMPTS = savedBun;
      if (savedProcess !== undefined) process.env.PIPLUS_FORCE_ROLE_PROMPTS = savedProcess;
    }
  }

  test('(a) 已存在的旧版内置提示词被更新为代码新版', () => {
    const { dir, dbPath } = seedFreshDb();
    try {
      const before = readRoles(dbPath);
      const expected = new Map(before.map((r) => [r.id as string, r.base_prompt]));
      expect(expected.get('role_feature_lead')).toContain('子会话使用纪律');
      // 模拟旧库：把内置提示词改成过期内容
      writeDb(dbPath, (sqlite) => {
        sqlite
          .prepare(
            "UPDATE role_templates SET base_prompt = 'OLD PROMPT' WHERE id IN ('role_feature_lead', 'role_bugfix_lead', 'role_worker')",
          )
          .run();
      });
      withoutForceFlag(() => createSeedDb(dbPath));
      const after = readRoles(dbPath);
      for (const row of after) {
        if (['role_feature_lead', 'role_bugfix_lead', 'role_worker'].includes(row.id as string)) {
          expect(row.base_prompt).toBe(expected.get(row.id as string));
          expect(row.base_prompt).not.toBe('OLD PROMPT');
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(b) 用户自建角色行原样保留', () => {
    const { dir, dbPath } = seedFreshDb();
    try {
      writeDb(dbPath, (sqlite) => {
        sqlite
          .prepare(
            `INSERT INTO role_templates (id, key, version, name, description, base_prompt, config_json, created_by, owner_type, visibility, is_builtin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            'role_custom_abc123',
            'my-role',
            'v1',
            '我的角色',
            '用户自建',
            'USER PROMPT',
            '{"icon":"Heart"}',
            'user_1',
            'user',
            'public',
            0,
            111,
            222,
          );
        // 同时把一个内置行改旧，确认两者行为差异
        sqlite.prepare("UPDATE role_templates SET base_prompt = 'OLD' WHERE id = 'role_planner'").run();
      });
      const userBefore = readRoles(dbPath).find((r) => r.id === 'role_custom_abc123');
      withoutForceFlag(() => createSeedDb(dbPath));
      const rows = readRoles(dbPath);
      const userAfter = rows.find((r) => r.id === 'role_custom_abc123');
      expect(userAfter).toEqual(userBefore);
      expect(rows.find((r) => r.id === 'role_planner')!.base_prompt).not.toBe('OLD');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(c) 反复启动结果幂等', () => {
    const { dir, dbPath } = seedFreshDb();
    try {
      const first = readRoles(dbPath);
      withoutForceFlag(() => createSeedDb(dbPath));
      const second = readRoles(dbPath);
      withoutForceFlag(() => createSeedDb(dbPath));
      const third = readRoles(dbPath);
      // 内容无变化时不产生写入：全表逐行完全一致（含 updated_at）
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('(d) feature_lead 与 bugfix_lead 的 worker 派发纪律表述一致、不再鼓励派发', () => {
    const { dir, dbPath } = seedFreshDb();
    try {
      const rows = readRoles(dbPath);
      const promptOf = (id: string) => String(rows.find((r) => r.id === id)!.base_prompt);
      const feature = promptOf('role_feature_lead');
      const bugfix = promptOf('role_bugfix_lead');
      const disciplineLines = (prompt: string) => prompt.split('\n').filter((line) => line.startsWith('- 子会话使用纪律'));

      // 两份提示词引用同一段纪律文字，避免表述漂移/自相矛盾
      const featureDiscipline = disciplineLines(feature);
      const bugfixDiscipline = disciplineLines(bugfix);
      expect(featureDiscipline).toHaveLength(1);
      expect(bugfixDiscipline).toHaveLength(1);
      expect(featureDiscipline[0]).toBe(bugfixDiscipline[0]);

      // 纪律要点：只用于并行提速、串行/简单任务自己做、拿不准自己做
      expect(featureDiscipline[0]).toContain('worker 只用于并行提速');
      expect(featureDiscipline[0]).toContain('串行/顺序执行的步骤、简单任务');
      expect(featureDiscipline[0]).toContain('拿不准是否值得并行');

      for (const prompt of [feature, bugfix]) {
        // 删除鼓励派发的旧表述
        expect(prompt).not.toContain('最大化并行性');
        expect(prompt).not.toContain('创建 worker（`wait=true`）');
        // 保留必要信息：objective/scope/task 三件套、用户对齐不委派
        expect(prompt).toContain('objective/scope/task');
        expect(prompt).toContain('不委派给 worker');
        expect(prompt).toContain('派发 worker');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
