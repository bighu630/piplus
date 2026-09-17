import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import FilePathLabel from './FilePathLabel';

// 路径标签验收测试：拆成「可省略的目录前缀 + 完整的文件名」，省略方向在左侧（保留尾部目录）。

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

const dirEl = () => container!.querySelector('[data-testid="file-path-dir"]');
const baseEl = () => container!.querySelector('[data-testid="file-path-base"]');

describe('FilePathLabel', () => {
  test('拆分目录前缀与文件名', () => {
    render(<FilePathLabel path="/root/data/code/test/test_folder/testfile.txt" />);

    expect(dirEl()!.textContent).toBe('/root/data/code/test/test_folder/');
    expect(baseEl()!.textContent).toBe('testfile.txt');
  });

  test('目录段用 rtl 块方向 + 行内 LTR 隔离实现「省略前面」', () => {
    render(<FilePathLabel path="/root/a/b.txt" />);

    const dir = dirEl()!;
    // 省略端跟随块方向：rtl → 省略号在左侧
    expect(dir.className).toContain('[direction:rtl]');
    expect(dir.className).toContain('text-ellipsis');
    expect(dir.className).toContain('overflow-hidden');
    expect(dir.className).toContain('whitespace-nowrap');
    // 不能用 unicode-bidi:plaintext：它会把段落方向按首强字符重算，省略端回到右侧（实测）
    expect(dir.className).not.toContain('unicode-bidi');
    // 内容行内隔离为 LTR，避免 rtl 块方向重排 `/`、`.` 等中性字符
    expect(dir.querySelector('[dir="ltr"]')).not.toBeNull();
    expect(dir.querySelector('[dir="ltr"]')!.textContent).toBe('/root/a/');
  });

  test('Windows 反斜杠路径按最后一个分隔符切分（保留原字符）', () => {
    render(<FilePathLabel path={'C:\\Users\\me\\project\\file.txt'} />);

    expect(dirEl()!.textContent).toBe('C:\\Users\\me\\project\\');
    expect(baseEl()!.textContent).toBe('file.txt');
  });

  test('title 传 null 时不显示 tooltip（占位符场景）', () => {
    render(<FilePathLabel path="(未提供路径)" title={null} />);
    expect(container!.querySelector('[data-testid="file-path-label"]')!.getAttribute('title')).toBeNull();
  });

  test('文件名优先完整显示（不收缩，仅超宽时自身省略）', () => {
    render(<FilePathLabel path="/root/a/b.txt" />);

    const base = baseEl()!;
    expect(base.className).toContain('shrink-0');
    expect(base.className).toContain('max-w-full');
    expect(base.className).toContain('text-ellipsis');
  });

  test('title 提供完整路径', () => {
    render(<FilePathLabel path="/root/data/testfile.txt" />);
    expect(container!.querySelector('[data-testid="file-path-label"]')!.getAttribute('title')).toBe(
      '/root/data/testfile.txt',
    );
  });

  test('无目录的纯文件名：不渲染目录段', () => {
    render(<FilePathLabel path="testfile.txt" />);

    expect(dirEl()).toBeNull();
    expect(baseEl()!.textContent).toBe('testfile.txt');
  });

  test('根目录文件：目录为 "/"', () => {
    render(<FilePathLabel path="/file.txt" />);

    expect(dirEl()!.textContent).toBe('/');
    expect(baseEl()!.textContent).toBe('file.txt');
  });

  test('可自定义目录段最大宽度', () => {
    render(<FilePathLabel path="/a/b.txt" dirMaxWidthClass="max-w-[120px]" />);
    expect(dirEl()!.className).toContain('max-w-[120px]');
  });
});
