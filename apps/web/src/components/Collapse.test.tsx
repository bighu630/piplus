import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { MotionGlobalConfig } from 'motion/react';
import Collapse from './Collapse';

// Collapse 高度展开/收起容器的验收测试：
// - 关闭时不渲染；展开时渲染子节点并透传 testId / className
// - 收起动画结束后卸载子节点（受控 open 语义）
// - 重新展开时子节点状态复位（依赖卸载重建）

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalSkipAnimations = MotionGlobalConfig.skipAnimations;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // happy-dom 下 motion 的退出动画不会自然结束；跳过动画，让「收起后卸载」语义在测试中可用
  MotionGlobalConfig.skipAnimations = true;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  MotionGlobalConfig.skipAnimations = originalSkipAnimations;
});

function render(node: React.ReactElement) {
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

async function click(el: Element | null) {
  await act(async () => {
    (el as HTMLButtonElement).click();
  });
}

const toggle = () => container!.querySelector('[data-testid="toggle"]');
const panel = () => container!.querySelector('[data-testid="panel"]');
const inner = () => container!.querySelector('[data-testid="inner"]');

function Harness({ initialOpen = false, children }: { initialOpen?: boolean; children?: React.ReactNode }) {
  const [open, setOpen] = useState(initialOpen);
  return (
    <div>
      <button data-testid="toggle" onClick={() => setOpen((v) => !v)}>
        toggle
      </button>
      <Collapse open={open} testId="panel" className="border-t border-slate-200">
        {children ?? <div data-testid="inner">content</div>}
      </Collapse>
    </div>
  );
}

describe('Collapse', () => {
  test('默认关闭：不渲染子节点', () => {
    render(<Harness />);
    expect(panel()).toBeNull();
    expect(inner()).toBeNull();
  });

  test('展开：渲染子节点并透传 testId / className', async () => {
    render(<Harness />);

    await click(toggle());

    expect(panel()).not.toBeNull();
    expect(inner()!.textContent).toBe('content');
    expect(panel()!.className).toContain('border-t');
  });

  test('收起：动画结束后卸载子节点', async () => {
    render(<Harness initialOpen />);
    expect(panel()).not.toBeNull();

    await click(toggle());
    expect(panel()).toBeNull();

    await click(toggle());
    expect(panel()).not.toBeNull();
  });

  test('首屏展开：initial=false 直接渲染（不阻塞挂载）', () => {
    render(<Harness initialOpen />);
    expect(panel()).not.toBeNull();
    expect(inner()).not.toBeNull();
  });

  test('重新展开时子节点状态复位（收起卸载 → 重建）', async () => {
    function Counter() {
      const [count, setCount] = useState(0);
      return (
        <button data-testid="inc" onClick={() => setCount((c) => c + 1)}>
          {count}
        </button>
      );
    }
    render(
      <Harness initialOpen>
        <Counter />
      </Harness>,
    );

    const inc = () => container!.querySelector('[data-testid="inc"]');
    await click(inc());
    await click(inc());
    expect(inc()!.textContent).toBe('2');

    await click(toggle()); // 收起：卸载
    await click(toggle()); // 重新展开：状态复位

    expect(inc()!.textContent).toBe('0');
  });
});
