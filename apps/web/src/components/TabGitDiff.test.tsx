import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import TabGitDiff from './TabGitDiff';

// TabGitDiff 行为测试：渲染烟测（git-diff → 文件树/明细）+ 刷新交互 + 折叠交互。
//
// 复用 SettingsPanel.timestamps.test.tsx 已验证的 harness：
// happy-dom Window + createRoot/act + QueryClientProvider（retry:false）+ 全局 fetch 桩，
// 按 URL 返回内存 git 数据，不依赖任何 mock.module（bun 顶层 mock 会跨文件泄漏）。

const DIFF_WITH_CHANGE = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,3 @@',
  ' const a = 1;',
  '+const b = 2;',
].join('\n');

const fetchState = {
  diff: DIFF_WITH_CHANGE as string,
  diffCalls: 0,
  commitsCalls: 0,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
const originalFetch = globalThis.fetch;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

const SESSION_ID = 'session-gitdiff-test';

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/git-diff')) {
      fetchState.diffCalls += 1;
      return jsonResponse({ session_id: SESSION_ID, diff: fetchState.diff, cwd: '/tmp/repo' });
    }
    if (url.includes('/git/branches')) {
      return jsonResponse({
        session_id: SESSION_ID,
        cwd: '/tmp/repo',
        current_branch: 'main',
        branches: [{ name: 'main', is_current: true, is_worktree: false, worktree_path: null }],
        session_worktree_path: null,
        detached: false,
        detached_ref: null,
      });
    }
    if (url.includes('/git/tags')) {
      return jsonResponse({ session_id: SESSION_ID, cwd: '/tmp/repo', detached: false, tags: [] });
    }
    if (url.includes('/git/remote-tags')) {
      return jsonResponse({
        session_id: SESSION_ID,
        cwd: '/tmp/repo',
        remote_ok: false,
        remote: null,
        error: null,
        tags: [],
      });
    }
    if (url.includes('/git/commits')) {
      fetchState.commitsCalls += 1;
      return jsonResponse({ session_id: SESSION_ID, cwd: '/tmp/repo', commits: [] });
    }
    if (url.includes('/git/show')) {
      return jsonResponse({ session_id: SESSION_ID, cwd: '/tmp/repo', hash: 'abc1234', message: '', author: '', date: '', diff: '' });
    }
    return jsonResponse({});
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  (globalThis as { navigator?: unknown }).navigator = originalNavigator;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  fetchState.diff = DIFF_WITH_CHANGE;
  fetchState.diffCalls = 0;
  fetchState.commitsCalls = 0;
});

async function renderGitDiff() {
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <TabGitDiff selectedSessionId={SESSION_ID} activeTab="diff" />
      </QueryClientProvider>,
    );
  });
  await flush();
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function buttonByText(text: string): HTMLButtonElement {
  const buttons = Array.from(container!.querySelectorAll('button'));
  const found = buttons.find((b) => b.textContent?.trim() === text);
  if (!found) throw new Error(`未找到按钮：${text}；实际按钮=${buttons.map((b) => b.textContent?.trim()).join(' | ')}`);
  return found as HTMLButtonElement;
}

describe('TabGitDiff 行为', () => {
  test('渲染烟测：git-diff 响应后渲染文件树与 diff 明细', async () => {
    await renderGitDiff();

    expect(fetchState.diffCalls).toBe(1);
    expect(container!.textContent).toContain('src/a.ts');
    expect(container!.textContent).toContain('const a = 1;');
    // 新增行去掉前导 '+' 后渲染
    expect(container!.textContent).toContain('const b = 2;');
    expect(container!.textContent).toContain('1 个文件');
  });

  test('无变更：diff 为空时渲染空态', async () => {
    fetchState.diff = '';
    await renderGitDiff();

    expect(container!.textContent).toContain('暂无变更');
    expect(container!.textContent).toContain('点击"刷新"获取当前会话的工作区差异');
  });

  test('刷新交互：点击「刷新」重新拉取 git-diff', async () => {
    await renderGitDiff();
    expect(fetchState.diffCalls).toBe(1);
    const before = fetchState.diffCalls;

    await act(async () => {
      buttonByText('刷新').click();
    });
    await flush();

    expect(fetchState.diffCalls).toBeGreaterThan(before);
    // 刷新后内容仍在
    expect(container!.textContent).toContain('const b = 2;');
  });

  test('折叠交互：点击文件名后隐藏该文件的 diff 明细', async () => {
    await renderGitDiff();
    expect(container!.textContent).toContain('const b = 2;');

    await act(async () => {
      buttonByText('src/a.ts').click();
    });

    expect(container!.textContent).not.toContain('const b = 2;');
    // 折叠后文件名仍在（只是明细收起）
    expect(container!.textContent).toContain('src/a.ts');
  });
});
