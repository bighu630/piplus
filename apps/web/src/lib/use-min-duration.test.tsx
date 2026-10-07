import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useMinDuration } from './use-min-duration';

// useMinDuration 依赖 React effect + 定时器：用 happy-dom + createRoot 真实渲染，真实等待短时长。
// 与 use-persistent-state.test.tsx 同一套挂载/卸载 harness。

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('useMinDuration', () => {
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

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    if (container) {
      (container as unknown as { remove: () => void }).remove();
      container = null;
    }
  });

  /** 挂载一个读取 useMinDuration 结果的探针，返回操作句柄 */
  function mountHook(minMs: number, initialActive: boolean) {
    let active = initialActive;
    let currentMinMs = minMs;
    let latest = false;
    function Probe() {
      latest = useMinDuration(active, currentMinMs);
      return null;
    }
    container = window.document.createElement('div') as unknown as HTMLElement;
    window.document.body.appendChild(container as unknown as Node);
    root = createRoot(container as unknown as Element);
    act(() => root!.render(<Probe />));
    return {
      latest: () => latest,
      setActive: (value: boolean) => {
        active = value;
        act(() => root!.render(<Probe />));
      },
      setMinMs: (value: number) => {
        currentMinMs = value;
        act(() => root!.render(<Probe />));
      },
    };
  }

  test('初始未激活时不展示', () => {
    const h = mountHook(40, false);
    expect(h.latest()).toBe(false);
  });

  test('激活后立即可见；过快结束时补足到 minMs', async () => {
    const h = mountHook(40, false);

    h.setActive(true);
    expect(h.latest()).toBe(true);

    // 立刻结束：应继续展示，直到补足 40ms
    h.setActive(false);
    expect(h.latest()).toBe(true);

    await act(async () => { await sleep(80); });
    expect(h.latest()).toBe(false);
  });

  test('已展示足够久后再结束：不额外延迟', async () => {
    const h = mountHook(30, true);
    expect(h.latest()).toBe(true);

    await act(async () => { await sleep(60); });
    h.setActive(false);
    expect(h.latest()).toBe(false);
  });

  test('补足期间重新激活会重置计时（不误收起）', async () => {
    const h = mountHook(60, false);

    h.setActive(true);
    h.setActive(false);
    expect(h.latest()).toBe(true);

    // 在补足窗口内重新激活并保持：不应被旧定时器收起
    await act(async () => { await sleep(20); });
    h.setActive(true);
    await act(async () => { await sleep(80); });
    expect(h.latest()).toBe(true);
  });

  test('补足期间 minMs 变化：不提前收起，仍按原截止时刻结束', async () => {
    const h = mountHook(80, false);

    h.setActive(true);
    h.setActive(false);
    expect(h.latest()).toBe(true);

    await act(async () => { await sleep(20); });
    // minMs 变化使 effect 重跑：旧实现会在此刻立刻收起
    h.setMinMs(1000);
    expect(h.latest()).toBe(true);

    // 截止时刻（激活后约 80ms）过后正常收起
    await act(async () => { await sleep(120); });
    expect(h.latest()).toBe(false);
  });
});
