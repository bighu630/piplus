import { describe, expect, test } from 'bun:test';
import type { ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';
import { findFirstSession, findProjectId, findSessionNode, updateNodeRuntimeStatus } from './tree-utils';

function node(overrides: Partial<SessionTreeNodeDTO> & { id: string }): SessionTreeNodeDTO {
  return {
    project_id: 'p1',
    parent_session_id: null,
    root_session_id: overrides.id,
    depth: 0,
    role_template_key: 'planner',
    title: overrides.id,
    status: 'active',
    runtime_status: 'idle',
    archived_at: null,
    pinned_at: null,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    children: [],
    ...overrides,
  } as SessionTreeNodeDTO;
}

function project(id: string, sessions: SessionTreeNodeDTO[]): ProjectDTO {
  return {
    id,
    name: id,
    status: 'active',
    project_path: `/workspace/${id}`,
    source_type: 'local',
    source_url: '',
    archived_at: null,
    pinned_at: null,
    last_activity_at: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
    sessions,
    role_default_models: {},
  } as ProjectDTO;
}

describe('findFirstSession', () => {
  test('returns the first non-archived session with its project', () => {
    const tree = [
      project('p1', [node({ id: 'a', archived_at: 'x' }), node({ id: 'b' })]),
      project('p2', [node({ id: 'c' })]),
    ];
    expect(findFirstSession(tree)).toEqual({ projectId: 'p1', sessionId: 'b' });
  });

  test('descends into children of archived nodes (BFS)', () => {
    const tree = [project('p1', [node({ id: 'a', archived_at: 'x', children: [node({ id: 'a1' })] })])];
    expect(findFirstSession(tree)).toEqual({ projectId: 'p1', sessionId: 'a1' });
  });

  test('returns null when every session is archived or tree is empty', () => {
    expect(findFirstSession([])).toBeNull();
    expect(findFirstSession([project('p1', [node({ id: 'a', archived_at: 'x' })])])).toBeNull();
  });
});

describe('findProjectId', () => {
  test('finds the owning project for a nested session', () => {
    const tree = [
      project('p1', [node({ id: 'a', children: [node({ id: 'a1', children: [node({ id: 'a2' })] })] })]),
      project('p2', [node({ id: 'b' })]),
    ];
    expect(findProjectId(tree, 'a2')).toBe('p1');
    expect(findProjectId(tree, 'b')).toBe('p2');
  });

  test('returns null for an unknown session', () => {
    expect(findProjectId([project('p1', [node({ id: 'a' })])], 'nope')).toBeNull();
  });
});

describe('findSessionNode', () => {
  test('finds nested sessions', () => {
    const tree = [project('p1', [node({ id: 'a', children: [node({ id: 'a1' })] })])];
    expect(findSessionNode(tree, 'a1')?.id).toBe('a1');
    expect(findSessionNode(tree, 'missing')).toBeNull();
  });
});

describe('updateNodeRuntimeStatus', () => {
  test('updates the target node and preserves immutability', () => {
    const child = node({ id: 'a1' });
    const parent = node({ id: 'a', children: [child] });
    const updated = updateNodeRuntimeStatus([parent], 'a1', 'running');
    expect(updated[0]!.runtime_status).toBe('idle');
    expect(updated[0]!.children[0]!.runtime_status).toBe('running');
    expect(parent.children[0]!.runtime_status).toBe('idle');
  });
});
