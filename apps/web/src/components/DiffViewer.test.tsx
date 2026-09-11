import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import DiffViewer from './DiffViewer';

// DiffViewer 明细渲染验收测试（摘要栏/折叠已上移 tool call 卡片头部，这里只验证明细与截断提示）。

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

const diffLines = () => [...container!.querySelectorAll('[data-testid="diff-line"]')];
const diffLinesOfType = (type: string) =>
  diffLines().filter((el) => el.getAttribute('data-line-type') === type);

describe('DiffViewer', () => {
  test('write：全部行标记为新增，末尾换行不产生空行', () => {
    render(<DiffViewer newText={'a\nb\n'} viewType="write" />);
    expect(diffLines()).toHaveLength(2);
    expect(diffLinesOfType('add')).toHaveLength(2);
    expect(diffLinesOfType('delete')).toHaveLength(0);
  });

  test('edit：渲染新增/删除/保留行', () => {
    render(<DiffViewer oldText={'a\nb'} newText={'a\nc'} viewType="edit" />);
    expect(diffLinesOfType('add')).toHaveLength(1);
    expect(diffLinesOfType('delete')).toHaveLength(1);
    expect(diffLinesOfType('same')).toHaveLength(1);
    expect(container!.textContent).toContain('c');
    expect(container!.textContent).toContain('b');
  });

  test('edit 缺少 oldText 时按全量新增处理', () => {
    render(<DiffViewer newText={'x\ny'} viewType="edit" />);
    expect(diffLinesOfType('add')).toHaveLength(2);
  });

  test('超过 150 行时显示截断提示并限制渲染行数', () => {
    const text = Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n');
    render(<DiffViewer newText={text} viewType="write" />);

    expect(diffLines()).toHaveLength(150);
    expect(container!.textContent).toContain('Diff 过长');
    expect(container!.textContent).toContain('共 300 行');
    expect(container!.textContent).toContain('line 0');
    expect(container!.textContent).toContain('line 299');
  });

  test('不含折叠/摘要控件（摘要已上移卡片头部）', () => {
    render(<DiffViewer newText={'a'} viewType="write" />);
    expect(container!.querySelectorAll('button')).toHaveLength(0);
  });
});
