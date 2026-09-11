import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import ToolResultView from './ToolResultView';

// 通用工具结果视图验收测试：内容渲染、空输出占位、失败样式、超长截断（统一 200 行、提示在滚动容器外）。

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

function setupGlobals() {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

beforeAll(() => {
  setupGlobals();
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
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

describe('ToolResultView', () => {
  test('普通内容原样渲染（成功中性色）', () => {
    render(<ToolResultView content={'line1\nline2'} />);
    const pre = container!.querySelector('pre')!;
    expect(pre.textContent).toBe('line1\nline2');
    expect(pre.className).toContain('text-slate-700');
  });

  test('空内容与仅空白显示「（无输出）」占位', () => {
    render(<ToolResultView content={''} />);
    expect(container!.textContent).toContain('（无输出）');
    expect(container!.querySelector('pre')).toBeNull();
  });

  test('失败文本用 rose 样式', () => {
    render(<ToolResultView content={'Error: exit code 1'} />);
    expect(container!.querySelector('pre')!.className).toContain('text-rose-700');
  });

  test('超长内容截断到 200 行，提示在滚动容器外', () => {
    const content = Array.from({ length: 620 }, (_, i) => `line ${i}`).join('\n');
    render(<ToolResultView content={content} />);

    const pre = container!.querySelector('pre')!;
    expect(pre.textContent!.split('\n')).toHaveLength(200);
    expect(container!.textContent).toContain('仅显示前 200 行（共 620 行）');
    expect(container!.querySelector('.max-h-96')!.textContent).not.toContain('仅显示前');
  });

  test('恰好 200 行不截断', () => {
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    render(<ToolResultView content={content} />);
    expect(container!.textContent).not.toContain('仅显示前');
  });
});
