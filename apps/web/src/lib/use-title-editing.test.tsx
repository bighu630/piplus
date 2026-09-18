import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
// 静态导入真实 hooks，再用 spread 覆盖单个导出：这样即使 bun 的 mock.module 跨文件生效，
// 其它依赖 hooks 的测试文件仍能拿到真实实现（否则会报 useAuthSession 未找到）。
import * as realHooks from './hooks';

const mutateCalls: Array<{ sessionId: string; title: string }> = [];

mock.module('./hooks', () => ({
  ...realHooks,
  useUpdateSessionTitleMutation: () => ({
    mutate: (args: { sessionId: string; title: string }) => { mutateCalls.push(args); },
    isPending: false,
  }),
}));

const { useTitleEditing } = await import('./use-title-editing');

function sessionInfo(roleKey: string, depth: number, title: string): any {
  return {
    session: { id: 's1', title },
    role_template: { key: roleKey, version: '1', name: roleKey },
    lineage: { parent_session: null, root_session: null, depth },
  };
}

describe('useTitleEditing', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  let window: Window;
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let title!: ReturnType<typeof useTitleEditing>;
  let setInfo: (info: any) => void = () => {};
  let setSessionId: (id: string) => void = () => {};

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

  function mount(info: any): void {
    window = new Window({ url: 'https://demo.example.com/' });
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    // 原实现用裸 requestAnimationFrame（浏览器全局）；测试环境把 happy-dom 的版本挂上
    (globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      (cb) => (window as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame(cb);
    mutateCalls.length = 0;

    function Probe() {
      const [current, setCurrent] = useState<any>(info);
      const [sessionId, setSid] = useState('s1');
      setInfo = setCurrent;
      setSessionId = setSid;
      title = useTitleEditing({ selectedSessionId: sessionId, sessionInfo: current });
      return null;
    }

    container = window.document.createElement('div') as unknown as HTMLElement;
    window.document.body.appendChild(container as unknown as Node);
    root = createRoot(container as unknown as Element);
    act(() => root!.render(<Probe />));
  }

  test('starts editing with the current title and saves once', () => {
    mount(sessionInfo('worker', 1, 'Worker Task'));

    act(() => title.handleStartEditTitle());
    expect(title.editingTitle).toBe(true);
    expect(title.editTitleValue).toBe('Worker Task');

    act(() => title.handleSaveTitle());
    expect(mutateCalls).toEqual([{ sessionId: 's1', title: 'Worker Task' }]);
    expect(title.editingTitle).toBe(false);

    // 第二次保存被 titleSavedRef 去重
    act(() => title.handleSaveTitle());
    expect(mutateCalls).toHaveLength(1);
  });

  test('refuses to edit the planner root session', () => {
    mount(sessionInfo('planner', 0, 'Planner Root'));

    act(() => title.handleStartEditTitle());
    expect(title.editingTitle).toBe(false);
    expect(title.editTitleValue).toBe('');
  });

  test('allows editing a planner sub-session (depth > 0)', () => {
    mount(sessionInfo('planner', 1, 'Planner Child'));

    act(() => title.handleStartEditTitle());
    expect(title.editingTitle).toBe(true);
    expect(title.editTitleValue).toBe('Planner Child');
  });

  test('escape cancels without saving', () => {
    mount(sessionInfo('worker', 1, 'Worker Task'));

    act(() => title.handleStartEditTitle());
    act(() => title.handleTitleKeyDown({ key: 'Escape' } as any));

    expect(title.editingTitle).toBe(false);
    expect(title.editTitleValue).toBe('');
    expect(mutateCalls).toHaveLength(0);
  });

  test('enter saves', () => {
    mount(sessionInfo('worker', 1, 'Worker Task'));

    act(() => title.handleStartEditTitle());
    act(() => title.setEditTitleValue('Renamed'));
    act(() => title.handleTitleKeyDown({ key: 'Enter' } as any));

    expect(mutateCalls).toEqual([{ sessionId: 's1', title: 'Renamed' }]);
  });

  test('empty title just exits edit mode', () => {
    mount(sessionInfo('worker', 1, 'Worker Task'));

    act(() => title.handleStartEditTitle());
    act(() => title.setEditTitleValue('   '));
    act(() => title.handleSaveTitle());

    expect(title.editingTitle).toBe(false);
    expect(mutateCalls).toHaveLength(0);
  });

  test('switching sessions exits edit mode and clears the draft', () => {
    mount(sessionInfo('worker', 1, 'Worker Task'));

    act(() => title.handleStartEditTitle());
    act(() => title.setEditTitleValue('partial edit'));
    expect(title.editingTitle).toBe(true);

    act(() => setSessionId('s2'));

    expect(title.editingTitle).toBe(false);
    expect(title.editTitleValue).toBe('');
    expect(mutateCalls).toHaveLength(0);
  });
});
