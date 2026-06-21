import { describe, expect, test } from 'bun:test';
import { buildRoleManagerToolDefs } from './role-manager-tools';

function makeCatalog(roles: Array<{ key: string; name: string; description: string }>) {
  return {
    roles: roles.map((role) => ({ ...role, source: 'builtin' as const })),
  };
}

describe('role manager tools', () => {
  test('spawn_session description lists available roles from catalog', () => {
    const catalog = makeCatalog([
      { key: 'worker', name: 'Worker', description: 'Executes tasks.' },
      { key: 'reviewer', name: 'Reviewer', description: 'Reviews output.' },
    ]);

    const defs = buildRoleManagerToolDefs(catalog);
    const spawn = defs.find((d) => d.name === 'spawn_session');
    expect(spawn).toBeDefined();
    expect(spawn!.description).toContain('worker');
    expect(spawn!.description).toContain('Executes tasks.');
    expect(spawn!.description).toContain('reviewer');
    expect(spawn!.description).toContain('Reviews output.');
  });

  test('spawn_session includes A-style parameters', () => {
    const catalog = makeCatalog([{ key: 'worker', name: 'Worker', description: 'Executes tasks.' }]);
    const defs = buildRoleManagerToolDefs(catalog);
    const spawn = defs.find((d) => d.name === 'spawn_session');
    const props = (spawn!.parameters as Record<string, unknown>).properties as Record<string, unknown>;

    expect(props.role).toBeDefined();
    expect(props.objective).toBeDefined();
    expect(props.scope).toBeDefined();
    expect(props.task).toBeDefined();
    expect(props.constraints).toBeDefined();
  });

  test('writeback_to_parent is included', () => {
    const catalog = makeCatalog([]);
    const defs = buildRoleManagerToolDefs(catalog);
    expect(defs.some((d) => d.name === 'writeback_to_parent')).toBe(true);
  });
});
