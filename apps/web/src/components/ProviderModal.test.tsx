import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import ProviderModal from './ProviderModal';

// ProviderModal 行为测试：isOpen 渲染开关 + 关闭交互 + 自定义提供商列表渲染。
//
// 复用 SettingsPanel.timestamps.test.tsx 已验证的 harness：
// happy-dom Window + createRoot/act + QueryClientProvider（retry:false）+ 全局 fetch 桩。
// 不使用 mock.module（bun 顶层 mock 会跨文件泄漏）。

const fetchState = {
  providers: [
    {
      providerKey: 'my-provider',
      baseUrl: 'https://api.example.com/v1',
      authHeader: true,
      models: [{ id: 'm1' }],
    },
  ] as Array<Record<string, unknown>>,
  providersCalls: 0,
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

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/models/native-providers')) {
      return jsonResponse({
        providers: [{ provider: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', hasAuth: false }],
      });
    }
    if (url.includes('/api/v1/models/providers')) {
      fetchState.providersCalls += 1;
      return jsonResponse({ ok: true, providers: fetchState.providers });
    }
    if (url.includes('/api/v1/models/status')) return jsonResponse({ ok: true, count: 0, models: [] });
    if (url.includes('/api/v1/models')) return jsonResponse({ models: [] });
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
  fetchState.providersCalls = 0;
});

async function renderModal(props: { isOpen: boolean; onClose?: () => void }) {
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const onClose = props.onClose ?? (() => {});
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <ProviderModal isOpen={props.isOpen} onClose={onClose} />
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

describe('ProviderModal 行为', () => {
  test('isOpen=false：不渲染弹窗内容', async () => {
    await renderModal({ isOpen: false });

    expect(container!.textContent).not.toContain('添加模型');
    expect(container!.textContent).not.toContain('平台密钥');
  });

  test('渲染烟测：isOpen=true 时渲染标题与三个 tab', async () => {
    await renderModal({ isOpen: true });

    expect(container!.textContent).toContain('添加模型');
    expect(container!.textContent).toContain('平台密钥');
    expect(container!.textContent).toContain('自定义提供商');
    expect(container!.textContent).toContain('编辑提供商');
  });

  test('关闭交互：点击右上角关闭按钮触发 onClose', async () => {
    let closeCalls = 0;
    await renderModal({ isOpen: true, onClose: () => { closeCalls += 1; } });

    // 用关闭图标的 class 定位：Modal 内的关闭按钮带 svg.lucide-x，不依赖 button[type="button"] 的结构巧合。
    // 注意：querySelector(...)?.closest(...) 缺失时返回 undefined，而 undefined 能通过 not.toBeNull()，
    // 因此这里显式 throw，避免失败信息指向后续的 click。
    const closeButton = container!.querySelector('svg.lucide-x')?.closest('button');
    if (!closeButton) throw new Error('未找到 Modal 关闭按钮（svg.lucide-x）');

    await act(async () => {
      (closeButton as HTMLButtonElement).click();
    });

    expect(closeCalls).toBe(1);
  });

  test('列表渲染：切到「编辑提供商」后展示 fetch 返回的提供商', async () => {
    await renderModal({ isOpen: true });

    await act(async () => {
      buttonByText('编辑提供商').click();
    });
    await flush();

    expect(fetchState.providersCalls).toBeGreaterThanOrEqual(1);
    expect(container!.textContent).toContain('my-provider');
    expect(container!.textContent).toContain('1 个模型');
    expect(container!.textContent).toContain('https://api.example.com/v1');
  });
});
