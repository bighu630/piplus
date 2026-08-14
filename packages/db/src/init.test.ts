import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findMigrationFile, getMigrationFileCandidates } from './init';

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
