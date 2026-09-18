import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ProjectDTO, SessionTreeNodeDTO } from '@piplus/shared';

// 隔离 WS context 与运行时恢复（后者会真的发请求）：只验证 URL ↔ 会话选择逻辑。
const contextCalls: Array<{ sessionId: string | null; projectId: string | null; tab: string }> = [];

mock.module('./ws-provider', () => ({
  useWebSocket: () => ({
    setSessionContext: (sessionId: string | null, projectId: string | null, tab: string) => {
      contextCalls.push({ sessionId, projectId, tab });
    },
  }),
}));

mock.module('./api', () => ({
  restoreSessionRuntime: async () => {},
}));

const { useSessionSelection } = await import('./use-session-selection');

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

describe('useSessionSelection', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  let window: Window;
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let selection!: ReturnType<typeof useSessionSelection>;
  let setTree: (tree: ProjectDTO[]) => void = () => {};
  let setMobile: (value: boolean) => void = () => {};
  let selectedEvents: number;

  beforeAll(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      container.remove();
      container = null;
    }
  });

  function mount(url: string): void {
    window = new Window({ url });
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    contextCalls.length = 0;
    selectedEvents = 0;

    function Probe() {
      const [tree, setTreeState] = useState<ProjectDTO[]>([]);
      const [isMobile, setIsMobile] = useState(false);
      setTree = setTreeState;
      setMobile = setIsMobile;
      selection = useSessionSelection({
        tree,
        isMobile,
        activeTab: 'chat',
        onSessionSelected: () => { selectedEvents += 1; },
      });
      return null;
    }

    container = window.document.createElement('div') as unknown as HTMLElement;
    window.document.body.appendChild(container as unknown as Node);
    root = createRoot(container as unknown as Element);
    act(() => root!.render(<Probe />));
  }

  test('falls back to the first non-archived session and syncs the URL', () => {
    mount('https://demo.example.com/');
    expect(selection.selectedSessionId).toBeNull();
    // 桌面端移动侧边栏状态恒为 false，且两侧都可见
    expect(selection.showMobileSidebar).toBe(false);
    expect(selection.isSidebarVisible).toBe(true);
    expect(selection.isContentVisible).toBe(true);

    act(() => setTree([project('p1', [node({ id: 'a', archived_at: 'x' }), node({ id: 'b' })])]));

    expect(selection.selectedSessionId).toBe('b');
    expect(selection.selectedProjectId).toBe('p1');
    expect(window.location.pathname).toBe('/workspace/session/b');
  });

  test('restores the session encoded in the URL when it exists in the tree', () => {
    mount('https://demo.example.com/workspace/session/s2');
    act(() => setTree([project('p1', [node({ id: 'a' })]), project('p2', [node({ id: 's2' })])]));

    expect(selection.selectedSessionId).toBe('s2');
    expect(selection.selectedProjectId).toBe('p2');
    expect(window.location.pathname).toBe('/workspace/session/s2');
  });

  test('ignores a URL session missing from the tree and falls back', () => {
    mount('https://demo.example.com/workspace/session/ghost');
    act(() => setTree([project('p1', [node({ id: 'a' })])]));

    expect(selection.selectedSessionId).toBe('a');
    expect(window.location.pathname).toBe('/workspace/session/a');
  });

  test('selecting a session resets UI and hides the mobile sidebar', () => {
    mount('https://demo.example.com/');
    act(() => setTree([project('p1', [node({ id: 'a' }), node({ id: 'b' })]), project('p2', [node({ id: 'c' })])]));
    act(() => setMobile(true));
    expect(selection.isSidebarVisible).toBe(false);
    expect(selection.isContentVisible).toBe(true);

    act(() => selection.handleSelectSession('p2', 'c'));

    expect(selection.selectedSessionId).toBe('c');
    expect(selection.selectedProjectId).toBe('p2');
    expect(selection.showMobileSidebar).toBe(false);
    expect(selection.isSidebarVisible).toBe(false);
    expect(selection.isContentVisible).toBe(true);
    expect(selectedEvents).toBe(1);
    expect(window.location.pathname).toBe('/workspace/session/c');
  });

  test('navigating to a session not yet in the tree selects it directly, then resolves when the tree arrives', () => {
    mount('https://demo.example.com/');
    // 树为空：findProjectId 不可用，走「直接设置会话 id」分支
    act(() => selection.handleNavigateToSession('ghost'));
    expect(selection.selectedSessionId).toBe('ghost');
    expect(selection.selectedProjectId).toBeNull();
    expect(selectedEvents).toBe(1);

    // 树到达后校验 effect 自动定位到项目
    act(() => setTree([project('p1', [node({ id: 'ghost' })])]));
    expect(selection.selectedProjectId).toBe('p1');
    expect(window.location.pathname).toBe('/workspace/session/ghost');
  });

  test('navigating to a session missing from a loaded tree falls back to the first session', () => {
    mount('https://demo.example.com/');
    act(() => setTree([project('p1', [node({ id: 'a' })])]));
    act(() => selection.handleNavigateToSession('ghost'));

    // 先直接选中，随后校验 effect 发现不在树中 → 回退到第一个未归档会话
    expect(selection.selectedSessionId).toBe('a');
    expect(window.location.pathname).toBe('/workspace/session/a');
  });

  test('publishes the session context to the WS layer', () => {
    mount('https://demo.example.com/');
    act(() => setTree([project('p1', [node({ id: 'a' })])]));
    expect(contextCalls.at(-1)).toEqual({ sessionId: 'a', projectId: 'p1', tab: 'chat' });
  });
});
