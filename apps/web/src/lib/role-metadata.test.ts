import { describe, expect, test } from 'bun:test';
import { CONFIGURABLE_ROLE_KEYS, ROLE_KEYS, ROLE_LABELS, getAllRoleKeys, getRoleLabel } from './role-metadata';

describe('ROLE_KEYS / ROLE_LABELS / getRoleLabel', () => {
  test('六个内置角色的 key 与顺序', () => {
    expect(ROLE_KEYS.map((r) => r.key)).toEqual([
      'planner',
      'worker',
      'reviewer',
      'feature_lead',
      'bugfix_lead',
      'blank',
    ]);
  });

  test('六个内置角色的中文标签', () => {
    expect(getRoleLabel('planner')).toBe('负责人');
    expect(getRoleLabel('worker')).toBe('执行者');
    expect(getRoleLabel('reviewer')).toBe('审查者');
    expect(getRoleLabel('feature_lead')).toBe('需求负责人');
    expect(getRoleLabel('bugfix_lead')).toBe('Bug负责人');
    expect(getRoleLabel('blank')).toBe('空白');
  });

  test('planner 不再是「规划者」', () => {
    // 后端 role-manager 编译出的会话标题/提示词含「负责人」，前端必须一致
    expect(getRoleLabel('planner')).not.toBe('规划者');
    expect(ROLE_KEYS.find((r) => r.key === 'planner')?.label).toBe('负责人');
  });

  test('未知 key 回退为 key 本身', () => {
    expect(getRoleLabel('unknown_role')).toBe('unknown_role');
    expect(getRoleLabel('')).toBe('');
  });

  test('ROLE_LABELS 由 ROLE_KEYS 派生且与之完全一致', () => {
    expect(Object.keys(ROLE_LABELS)).toEqual(ROLE_KEYS.map((r) => r.key));
    for (const r of ROLE_KEYS) {
      expect(ROLE_LABELS[r.key]).toBe(r.label);
    }
  });
});

describe('CONFIGURABLE_ROLE_KEYS', () => {
  test('包含除 planner 外的全部内置角色', () => {
    expect(CONFIGURABLE_ROLE_KEYS.map((r) => r.key)).toEqual([
      'worker',
      'reviewer',
      'feature_lead',
      'bugfix_lead',
      'blank',
    ]);
  });

  test('不含 planner', () => {
    expect(CONFIGURABLE_ROLE_KEYS.some((r) => r.key === 'planner')).toBe(false);
  });
});

describe('getAllRoleKeys', () => {
  test('无模板时只返回内置角色，且保持内置顺序', () => {
    expect(getAllRoleKeys(undefined).map((r) => r.key)).toEqual(ROLE_KEYS.map((r) => r.key));
    expect(getAllRoleKeys([]).map((r) => r.key)).toEqual(ROLE_KEYS.map((r) => r.key));
  });

  test('自定义角色追加在内置角色之后，并按 key 字母序排列', () => {
    const result = getAllRoleKeys([
      { key: 'zeta', name: 'Zeta 角色', isBuiltin: false },
      { key: 'alpha', name: 'Alpha 角色', isBuiltin: false },
    ]);
    expect(result.map((r) => r.key)).toEqual([...ROLE_KEYS.map((r) => r.key), 'alpha', 'zeta']);
    // 自定义角色使用模板 name 作为 label
    expect(result[result.length - 2]).toEqual({ key: 'alpha', label: 'Alpha 角色' });
    expect(result[result.length - 1]).toEqual({ key: 'zeta', label: 'Zeta 角色' });
  });

  test('自定义角色 key 去重（保留首次出现的 label）', () => {
    const result = getAllRoleKeys([
      { key: 'custom', name: '第一次', isBuiltin: false },
      { key: 'custom', name: '第二次', isBuiltin: false },
    ]);
    const customEntries = result.filter((r) => r.key === 'custom');
    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]!.label).toBe('第一次');
  });

  test('内置 key 不会被模板列表重复追加', () => {
    const result = getAllRoleKeys([
      { key: 'planner', name: '不该出现的内置', isBuiltin: true },
      { key: 'worker', name: '不该出现的内置', isBuiltin: true },
    ]);
    expect(result).toEqual(ROLE_KEYS);
  });
});
