import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import ReadResultView from './ReadResultView';

// read 展开内容验收测试：正文渲染、空内容占位、失败样式、pi 续读提示、超长截断（提示在滚动容器外）。

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

describe('ReadResultView', () => {
  test('正文原样渲染（不带行号前缀）', () => {
    render(<ReadResultView content={'const a = 1;\nconst b = 2;'} />);
    expect(container!.querySelector('pre')!.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  test('空内容显示占位', () => {
    render(<ReadResultView content={''} />);
    expect(container!.textContent).toContain('（空内容）');
    expect(container!.querySelector('pre')).toBeNull();
  });

  test('仅空白内容也走空占位', () => {
    render(<ReadResultView content={'\n\n'} />);
    expect(container!.textContent).toContain('（空内容）');
  });

  test('失败文本用错误样式', () => {
    render(<ReadResultView content={'Error: ENOENT: no such file or directory'} />);
    expect(container!.querySelector('pre')!.className).toContain('text-rose-700');
  });

  test('pi 续读提示单独展示且不计入正文', () => {
    const content = 'l1\nl2\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]';
    render(<ReadResultView content={content} />);

    expect(container!.querySelector('pre')!.textContent).toBe('l1\nl2');
    expect(container!.textContent).toContain('[Showing lines 1-2 of 900. Use offset=3 to continue.]');
    expect(container!.textContent).not.toContain('仅显示前');
  });

  test('超长内容截断到 200 行并提示（提示在滚动容器外）', () => {
    const content = Array.from({ length: 620 }, (_, i) => `line ${i}`).join('\n');
    render(<ReadResultView content={content} />);

    const pre = container!.querySelector('pre')!;
    expect(pre.textContent!.split('\n')).toHaveLength(200);
    expect(container!.textContent).toContain('仅显示前 200 行（共 620 行）');
    expect(container!.querySelector('.max-h-96')!.textContent).not.toContain('仅显示前');
  });

  test('正文 501 行 + 续读提示：按正文计数且保留 pi 提示', () => {
    const body = Array.from({ length: 501 }, (_, i) => `line ${i}`).join('\n');
    render(<ReadResultView content={`${body}\n\n[Showing lines 1-501 of 900. Use offset=502 to continue.]`} />);

    expect(container!.textContent).toContain('仅显示前 200 行（共 501 行）');
    expect(container!.textContent).toContain('Use offset=502 to continue.');
  });
});
