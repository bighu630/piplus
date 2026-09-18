import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { usePersistentState } from './use-persistent-state';

// usePersistentState 依赖 localStorage 与 React effect：用 happy-dom + createRoot 真实渲染。
// 挂载/卸载只有一个入口，避免同一 container 被重复 createRoot。

describe('usePersistentState', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

  let window: Window;
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeAll(() => {
    window = new Window({ url: 'https://demo.example.com/' });
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterAll(() => {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  });

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    unmount();
  });

  function mount(probe: React.ReactElement): void {
    unmount();
    container = window.document.createElement('div') as unknown as HTMLElement;
    window.document.body.appendChild(container as unknown as Node);
    root = createRoot(container as unknown as Element);
    act(() => root!.render(probe));
  }

  function unmount(): void {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      (container as unknown as { remove: () => void }).remove();
      container = null;
    }
  }

  function renderHook<T>(hook: () => [T, (value: T) => void]): { latest: () => T } {
    let value!: T;
    function Probe() {
      const [state] = hook();
      value = state;
      return null;
    }
    mount(<Probe />);
    return { latest: () => value };
  }

  test('lazily reads the stored value through parse', () => {
    window.localStorage.setItem('k', 'true');
    const { latest } = renderHook(() => usePersistentState('k', false, { parse: (raw) => raw === 'true' }));
    expect(latest()).toBe(true);
  });

  test('falls back to initial when nothing is stored', () => {
    const { latest } = renderHook(() => usePersistentState('k', 'fallback', { parse: (raw) => raw }));
    expect(latest()).toBe('fallback');
  });

  test('treats an empty stored string as absent (legacy `if (saved)` semantics)', () => {
    window.localStorage.setItem('k', '');
    const { latest } = renderHook(() => usePersistentState('k', 'fallback', { parse: (raw) => `parsed:${raw}` }));
    expect(latest()).toBe('fallback');
  });

  test('writes the value back to localStorage after mount', () => {
    renderHook(() => usePersistentState('k', 42, { serialize: (v) => `n:${v}` }));
    expect(window.localStorage.getItem('k')).toBe('n:42');
  });

  test('persists updates made through the setter', () => {
    let set!: (value: number) => void;
    renderHook(() => {
      const [state, setState] = usePersistentState('k', 0);
      set = setState;
      return [state, setState];
    });
    act(() => set(7));
    expect(window.localStorage.getItem('k')).toBe('7');
  });

  test('serializes arrays with a custom serializer', () => {
    const options = {
      parse: (raw: string) => JSON.parse(raw) as string[],
      serialize: (v: string[]) => JSON.stringify(v),
    };
    const first = renderHook(() => usePersistentState<string[]>('roles', [], options));
    expect(first.latest()).toEqual([]);
    expect(window.localStorage.getItem('roles')).toBe('[]');

    window.localStorage.setItem('roles', JSON.stringify(['worker']));
    const second = renderHook(() => usePersistentState<string[]>('roles', [], options));
    expect(second.latest()).toEqual(['worker']);
  });
});
