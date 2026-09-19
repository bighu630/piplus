import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import MissingWorktreeNotice from './MissingWorktreeNotice';

// harness 同其它组件测试：happy-dom + createRoot/act，不使用 mock.module（顶层 mock 会跨文件泄漏）。
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
  container?.remove();
  container = null;
});

function render(worktreePath?: string | null) {
  // 先卸载上一个（同一 test 内可能连调），避免容器/root 残留到 afterAll
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  container?.remove();
  container = window.document.createElement('div') as unknown as HTMLElement;
  window.document.body.appendChild(container as unknown as Node);
  root = createRoot(container as unknown as Element);
  act(() => root!.render(<MissingWorktreeNotice worktreePath={worktreePath} />));
  return container;
}

describe('MissingWorktreeNotice', () => {
  test('路径为空时不渲染任何内容（无 worktree 失效就不打扰用户）', () => {
    expect(render(null).textContent).toBe('');
    expect(render(undefined).textContent).toBe('');
  });

  test('渲染原 worktree 路径与恢复指引', () => {
    const el = render('/tmp/gone-worktree-abc');
    const text = el.textContent ?? '';
    expect(text).toContain('/tmp/gone-worktree-abc');
    expect(text).toContain('已不存在');
    expect(text).toContain('回退到项目根'); // 说明后端已自愈
    expect(text).toContain('Git 标签重新切换分支'); // 可操作指引
    // 路径单独放在 code 里，长路径可换行
    expect(el.querySelector('code')?.textContent).toBe('/tmp/gone-worktree-abc');
  });

  test('作为状态提示播报（role=status）', () => {
    const el = render('/tmp/x');
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });
});
