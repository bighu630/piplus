import { describe, expect, test } from 'bun:test';
import { loadRoleCatalog } from './role-catalog';
import type { RoleManagerDb } from '../role-manager/service';

function emptyDb() {
  const queryable: any = Promise.resolve([]);
  queryable.orderBy = () => queryable;
  queryable.limit = () => queryable;
  return {
    select: () => ({
      from: () => ({
        where: () => queryable,
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as unknown as RoleManagerDb;
}

function dbWithRows(rows: Record<string, unknown>[]) {
  const queryable: any = Promise.resolve(rows);
  queryable.orderBy = () => queryable;
  queryable.limit = () => queryable;
  return {
    select: () => ({
      from: () => ({
        where: () => queryable,
      }),
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as unknown as RoleManagerDb;
}

// 按表名分发的 mock：drizzle 表对象可通过 table[Symbol.for('drizzle:Name')] 取表名
function dbWithProjectConfig(projectRow: Record<string, unknown> | null, templateRows: Record<string, unknown>[]) {
  return {
    select: () => ({
      from: (table: any) => {
        const tableName = table[Symbol.for('drizzle:Name')];
        const rows = tableName === 'projects' ? (projectRow ? [projectRow] : []) : templateRows;
        const queryable: any = Promise.resolve(rows);
        queryable.orderBy = () => queryable;
        queryable.limit = () => queryable;
        return {
          where: () => queryable,
        };
      },
    }),
    insert: () => ({ values: () => Promise.resolve() }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  } as unknown as RoleManagerDb;
}

describe('role catalog', () => {
  test('returns built-in roles even with an empty database', async () => {
    const catalog = await loadRoleCatalog(emptyDb());
    expect(catalog.roles.some((entry) => entry.key === 'planner')).toBe(true);
    expect(catalog.roles.some((entry) => entry.key === 'worker')).toBe(true);
    expect(catalog.roles.some((entry) => entry.key === 'reviewer')).toBe(true);
  });

  test('merges database role templates on top of built-ins', async () => {
    const catalog = await loadRoleCatalog(
      dbWithRows([
        {
          key: 'planner',
          name: 'Planner',
          description: 'DB-level planner description',
        },
        {
          key: 'custom_role',
          name: 'Custom Role',
          description: 'A user-defined role',
        },
      ]),
    );

    const planner = catalog.roles.find((entry) => entry.key === 'planner');
    expect(planner?.description).toBe('DB-level planner description');
    expect(planner?.source).toBe('db');

    expect(catalog.roles.some((entry) => entry.key === 'custom_role')).toBe(true);
  });

  test('旧项目（roleConfigJson="{}"）宽松行为：未配置的自定义角色自动加入目录', async () => {
    const catalog = await loadRoleCatalog(
      dbWithProjectConfig(
        { roleConfigJson: '{}' },
        [
          {
            key: 'custom_role',
            name: 'Custom Role',
            description: 'A user-defined role',
          },
        ],
      ),
      'project_test',
    );

    expect(catalog.roles.some((entry) => entry.key === 'custom_role')).toBe(true);
  });

  test('新项目（roleConfigJson 已初始化）严格行为：未配置的自定义角色不加入目录', async () => {
    const catalog = await loadRoleCatalog(
      dbWithProjectConfig(
        { roleConfigJson: '{"planner":{"enabled":true,"version":"内置"}}' },
        [
          {
            key: 'custom_role',
            name: 'Custom Role',
            description: 'A user-defined role',
          },
        ],
      ),
      'project_test',
    );

    expect(catalog.roles.some((entry) => entry.key === 'custom_role')).toBe(false);
  });
});
