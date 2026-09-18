import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import TabChat from './TabChat';
import { WebSocketProvider } from '../lib/ws-provider';

// TabChat 行为测试：渲染烟测 + 空态 + 归档按钮交互。
//
// 复用 SettingsPanel.timestamps.test.tsx / ChatTimestamps.test.tsx 已验证的 harness：
// happy-dom Window + createRoot/act + QueryClientProvider（retry:false，预置 query 缓存让
// auth / context-usage 直接命中缓存、不发请求），并额外挂全局 fetch 桩作为兜底。
//
// 注意：刻意不使用 mock.module —— bun 会在运行测试前加载所有测试文件的模块图，
// 顶层 mock 会跨文件泄漏（实测会破坏 ws-provider.test.tsx）。改用全局 fetch 桩。

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalIntersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
const originalNavigator = (globalThis as { navigator?: unknown }).navigator;
const originalFetch = globalThis.fetch;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

const SESSION_ID = 'session-tabchat-test';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** 预置缓存 + staleTime 无穷大：相关 query 视为新鲜，不触发网络请求。 */
function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });
  queryClient.setQueryData(['auth', 'status'], { requiresPassword: true });
  queryClient.setQueryData(['auth', 'session'], null);
  queryClient.setQueryData(['session', 'context-usage', SESSION_ID], null);
  return queryClient;
}

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  // hasMore=true 时 TabChat 用 IntersectionObserver 触顶加载，happy-dom 不提供，用空实现挡掉
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/auth/status')) return jsonResponse({ requiresPassword: true });
    if (url.includes('/api/v1/auth/')) return jsonResponse({ requiresPassword: true, ok: true });
    if (url.includes('/context-usage')) return jsonResponse(null);
    if (url.includes('/commands')) return jsonResponse({ commands: [] });
    if (url.includes('/api/v1/ask-pending')) return jsonResponse({ pending: [] });
    if (url.includes('/api/v1/role-templates')) return jsonResponse([]);
    if (url.includes('/api/v1/models')) return jsonResponse({ models: [], providers: [] });
    return jsonResponse({});
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIntersectionObserver;
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
  client = null;
});

const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute, 0)).toISOString();

function msg(partial: Partial<ChatMessageDTO> & { id: string }): ChatMessageDTO {
  return {
    role: 'assistant',
    message_kind: 'normal',
    source_session_id: null,
    content_text: '',
    created_at: T(0),
    tool_name: null,
    tool_args_json: null,
    ...partial,
  } as ChatMessageDTO;
}

interface ExtraProps {
  showArchiveButton?: boolean;
  onArchiveSession?: () => void;
  archivePending?: boolean;
}

function element(messages: ChatMessageDTO[], extra: ExtraProps, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <WebSocketProvider>
        <TabChat
          messages={messages}
          hasMore={false}
          loadingMore={false}
          onLoadMore={() => {}}
          onSend={async () => {}}
          onStop={() => {}}
          sending={false}
          runtimeStatus="idle"
          selectedSessionId={SESSION_ID}
          {...extra}
        />
      </WebSocketProvider>
    </QueryClientProvider>
  );
}

async function renderTabChat(messages: ChatMessageDTO[], extra: ExtraProps = {}) {
  client = makeClient();
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element(messages, extra, client!));
  });
  await flush();
}

/** 等 query → json 的微任务链落定 */
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

/**
 * 按 lucide 图标 class 定位按钮。
 * 归档按钮在 pending 时文案会变成 '...'，而「重新发送提示词」「压缩」pending 时同样渲染 '...'，
 * 用文案定位会点到别的禁用按钮、断言仍然全绿（空洞通过）。图标 class 唯一，故用它定位。
 */
function buttonByIcon(iconClass: string): HTMLButtonElement {
  const icon = container!.querySelector(`svg.${iconClass}`);
  const button = icon?.closest('button');
  if (!button) throw new Error(`未找到含图标 ${iconClass} 的按钮`);
  return button as HTMLButtonElement;
}

describe('TabChat 行为', () => {
  test('渲染烟测：给定消息能渲染出用户与助手内容', async () => {
    await renderTabChat([
      msg({ id: 'u1', role: 'user', content_text: '帮我看看这个 bug', created_at: T(0) }),
      msg({ id: 'a1', content_text: '好的，正在分析问题', created_at: T(1) }),
    ]);

    expect(container!.textContent).toContain('帮我看看这个 bug');
    expect(container!.textContent).toContain('好的，正在分析问题');
  });

  test('空态：无消息时显示占位文案', async () => {
    await renderTabChat([]);

    expect(container!.textContent).toContain('当前会话暂无消息。发送第一条消息开始对话。');
  });

  test('归档交互：showArchiveButton 时点击 Archive 触发 onArchiveSession 一次', async () => {
    let archiveCalls = 0;
    await renderTabChat(
      [msg({ id: 'u1', role: 'user', content_text: 'hi', created_at: T(0) })],
      { showArchiveButton: true, onArchiveSession: () => { archiveCalls += 1; } },
    );

    const archiveButton = buttonByIcon('lucide-archive');
    expect(archiveButton.disabled).toBe(false);

    await act(async () => {
      archiveButton.click();
    });

    expect(archiveCalls).toBe(1);
  });

  test('归档交互：archivePending 时按钮禁用且显示进行中', async () => {
    let archiveCalls = 0;
    await renderTabChat(
      [msg({ id: 'u1', role: 'user', content_text: 'hi', created_at: T(0) })],
      { showArchiveButton: true, onArchiveSession: () => { archiveCalls += 1; }, archivePending: true },
    );

    const archiveButton = buttonByIcon('lucide-archive');
    expect(archiveButton.disabled).toBe(true);
    // pending 态文案切为 '...'：定位已锚定图标，这里对文案的断言是非空洞的
    expect(archiveButton.textContent).toContain('...');

    await act(async () => {
      archiveButton.click();
    });

    expect(archiveCalls).toBe(0);
  });

  // 未覆盖：发送消息路径（输入草稿 → 回车 → onSend）。
  // 原因：本仓测试环境是 happy-dom + React 19，实测 dispatchEvent 无法驱动 text-input 的
  // onChange（onChange 收不到事件），与 AskQuestionCard.test.tsx:8 记录的同一限制。
  // 该路径依赖真实输入流程，若要覆盖需把渲染环境换成 jsdom（本仓已依赖 jsdom）。
  // 补充：实测同一环境下 React 的 onInput 是可驱动的（只有 onChange / onKeyDown 不行），
  // 所以若将来把 ChatInput 的输入改成 onInput，这条路径不迁 jsdom 也能测。
});
