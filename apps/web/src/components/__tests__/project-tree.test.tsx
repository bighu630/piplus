import { describe, expect, test, afterEach } from 'bun:test';
import { render, screen, cleanup } from '@testing-library/react';
import { ProjectTree } from '../project-tree';

describe('ProjectTree', () => {
  afterEach(() => cleanup());

  test('renders project section with name', () => {
    const tree = [
      {
        id: 'p1',
        name: 'Demo Project',
        status: 'active',
        archived_at: null,
        last_activity_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        sessions: [],
      },
    ];
    render(
      <ProjectTree
        activeSessionId={null}
        onSelectSession={() => {}}
        showArchived={false}
        tree={tree}
      />,
    );
    expect(screen.getByText('Demo Project')).toBeTruthy();
  });

  test('renders sessions within project', () => {
    const tree = [
      {
        id: 'p1',
        name: 'My Project',
        status: 'active',
        archived_at: null,
        last_activity_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        sessions: [
          {
            id: 's1',
            project_id: 'p1',
            parent_session_id: null,
            root_session_id: 's1',
            depth: 0,
            role_template_key: 'planner',
            title: 'Planner Session',
            status: 'active',
            runtime_status: 'idle',
            archived_at: null,
            last_activity_at: '2026-01-01T00:00:00Z',
            children: [],
          },
        ],
      },
    ];
    render(
      <ProjectTree
        activeSessionId={null}
        onSelectSession={() => {}}
        showArchived={false}
        tree={tree}
      />,
    );
    expect(screen.getByText('Planner Session')).toBeTruthy();
    expect(screen.getByText('planner')).toBeTruthy();
  });

  test('hides archived sessions when showArchived is false', () => {
    const tree = [
      {
        id: 'p1',
        name: 'P',
        status: 'active',
        archived_at: null,
        last_activity_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        sessions: [
          {
            id: 's1',
            project_id: 'p1',
            parent_session_id: null,
            root_session_id: 's1',
            depth: 0,
            role_template_key: 'blank',
            title: 'Archived Session',
            status: 'archived',
            runtime_status: 'idle',
            archived_at: '2026-01-01T00:00:00Z',
            last_activity_at: '2026-01-01T00:00:00Z',
            children: [],
          },
          {
            id: 's2',
            project_id: 'p1',
            parent_session_id: null,
            root_session_id: 's2',
            depth: 0,
            role_template_key: 'worker',
            title: 'Active Session',
            status: 'active',
            runtime_status: 'idle',
            archived_at: null,
            last_activity_at: '2026-01-01T00:00:00Z',
            children: [],
          },
        ],
      },
    ];
    render(
      <ProjectTree
        activeSessionId={null}
        onSelectSession={() => {}}
        showArchived={false}
        tree={tree}
      />,
    );
    expect(screen.queryByText('Archived Session')).toBeNull();
    expect(screen.getByText('Active Session')).toBeTruthy();
  });

  test('shows archived sessions when showArchived is true', () => {
    const tree = [
      {
        id: 'p1',
        name: 'P',
        status: 'active',
        archived_at: null,
        last_activity_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        sessions: [
          {
            id: 's1',
            project_id: 'p1',
            parent_session_id: null,
            root_session_id: 's1',
            depth: 0,
            role_template_key: 'blank',
            title: 'Archived Session',
            status: 'archived',
            runtime_status: 'idle',
            archived_at: '2026-01-01T00:00:00Z',
            last_activity_at: '2026-01-01T00:00:00Z',
            children: [],
          },
        ],
      },
    ];
    render(
      <ProjectTree
        activeSessionId={null}
        onSelectSession={() => {}}
        showArchived={true}
        tree={tree}
      />,
    );
    expect(screen.getByText('Archived Session')).toBeTruthy();
  });

  test('renders nested children', () => {
    const tree = [
      {
        id: 'p1',
        name: 'P',
        status: 'active',
        archived_at: null,
        last_activity_at: '2026-01-01T00:00:00Z',
        created_at: '2026-01-01T00:00:00Z',
        sessions: [
          {
            id: 's1',
            project_id: 'p1',
            parent_session_id: null,
            root_session_id: 's1',
            depth: 0,
            role_template_key: 'planner',
            title: 'Parent Session',
            status: 'active',
            runtime_status: 'idle',
            archived_at: null,
            last_activity_at: '2026-01-01T00:00:00Z',
            children: [
              {
                id: 's2',
                project_id: 'p1',
                parent_session_id: 's1',
                root_session_id: 's1',
                depth: 1,
                role_template_key: 'worker',
                title: 'Child Session',
                status: 'active',
                runtime_status: 'idle',
                archived_at: null,
                last_activity_at: '2026-01-01T00:00:00Z',
                children: [],
              },
            ],
          },
        ],
      },
    ];
    render(
      <ProjectTree
        activeSessionId={null}
        onSelectSession={() => {}}
        showArchived={false}
        tree={tree}
      />,
    );
    expect(screen.getByText('Parent Session')).toBeTruthy();
    // Children of expanded nodes (depth < 2) should be visible
    expect(screen.getByText('Child Session')).toBeTruthy();
  });
});
