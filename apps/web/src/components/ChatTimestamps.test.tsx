import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import TabChat from './TabChat';
import { WebSocketProvider } from '../lib/ws-provider';

// 「隐藏对话框时间戳」组件级验收：开启后仅会话首尾消息保留时间戳（含工具卡片），
// 关闭时行为不变；设置 prop 翻转后即时生效。
//
// 注意：这里刻意不使用 mock.module —— bun 会在运行测试前加载所有测试文件的模块图，
// 顶层 mock 会跨文件泄漏（实测会破坏 ws-provider.test.tsx 的 4 个用例）。
// 改用真实 WebSocketProvider + 预置 query 缓存（模拟未登录，provider 不会建连、不发请求）。

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalIntersectionObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;
let client: QueryClient | null = null;

const SESSION_ID = 'session-x';

/** 预置缓存 + staleTime 无穷大：相关 query 视为新鲜，不触发网络请求 */
function makeClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
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
  // hasMore=true 时 TabChat 用 IntersectionObserver 做触顶加载，happy-dom 不提供，用空实现挡掉
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalIntersectionObserver;
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

/** 分钟精度的时间工厂，保证每条消息时间戳互不相同、便于断言顺序 */
const T = (minute: number) => new Date(Date.UTC(2026, 0, 1, 10, minute, 0)).toISOString();
const T0 = T(0);
const T1 = T(1);
const T2 = T(2);
const T3 = T(3);
const T4 = T(4);
const T5 = T(5);

function msg(partial: Partial<ChatMessageDTO> & { id: string }): ChatMessageDTO {
  return {
    role: 'assistant',
    message_kind: 'normal',
    source_session_id: null,
    content_text: '',
    created_at: T0,
    tool_name: null,
    tool_args_json: null,
    ...partial,
  } as ChatMessageDTO;
}

function toolCall(id: string, toolName: string, toolCallId: string, args: Record<string, unknown>, createdAt: string): ChatMessageDTO {
  return msg({
    id,
    message_kind: 'tool_call',
    tool_name: toolName,
    tool_call_id: toolCallId,
    tool_args_json: JSON.stringify(args),
    created_at: createdAt,
  });
}

function toolResult(id: string, toolName: string, toolCallId: string, content: string, createdAt: string): ChatMessageDTO {
  return msg({
    id,
    role: 'tool',
    message_kind: 'tool',
    tool_name: toolName,
    tool_call_id: toolCallId,
    content_text: content,
    created_at: createdAt,
  });
}

/** 普通消息 + 单条工具调用/结果（结果由工具卡片承载） */
const basicMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: '第一条', created_at: T0 }),
  toolCall('tc1', 'bash', 'c1', { command: 'ls' }, T1),
  toolResult('tr1', 'bash', 'c1', 'ok', T2),
  msg({ id: 'a1', content_text: '最后一条', created_at: T3 }),
];

/** 连续两次 bash 调用合并为一张卡片，末条消息是被卡片承载的结果 */
const mergedMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'go', created_at: T0 }),
  toolCall('entry1-tool-0', 'bash', 'c1', { command: 'a' }, T1),
  toolResult('res-c1', 'bash', 'c1', 'A', T2),
  toolCall('entry1-tool-1', 'bash', 'c2', { command: 'b' }, T3),
  toolResult('res-c2', 'bash', 'c2', 'B', T4),
];

/** 文件聚合卡片（write）位于中间，末尾还有一条普通消息 */
const fileMidMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'edit a file', created_at: T0 }),
  toolCall('entry1-tool-0', 'write', 'w1', { path: 'a.ts', content: 'x' }, T1),
  toolResult('res-w1', 'write', 'w1', 'written', T2),
  msg({ id: 'a1', content_text: 'done', created_at: T5 }),
];

/** 文件聚合卡片就是末条（其结果为最后一条消息） */
const fileTailMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'edit a file', created_at: T0 }),
  toolCall('entry1-tool-1', 'write', 'w1', { path: 'a.ts', content: 'x' }, T1),
  toolResult('res-w1', 'write', 'w1', 'written', T2),
];

/** 单条 bash 调用且末条是被卡片承载的结果 */
const singleCallTailMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'run', created_at: T0 }),
  toolCall('tc1', 'bash', 'c1', { command: 'ls' }, T1),
  toolResult('tr1', 'bash', 'c1', 'ok', T2),
];

/** 末条是独立结果卡片（spawn_session 的结果不并入调用卡片） */
const standaloneTailMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'spawn', created_at: T0 }),
  toolCall('tc-spawn', 'spawn_session', 's1', { role: 'worker' }, T1),
  toolResult('res-spawn', 'spawn_session', 's1', JSON.stringify({ status: 'completed', summary: 'done' }), T2),
];

/** 末条是 ask_question 结果卡片（同样独立于调用卡片渲染） */
const askTailMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'ask', created_at: T0 }),
  toolCall('tc-ask', 'ask_question', 'a1', { question: 'q', options: ['x'] }, T1),
  toolResult('res-ask', 'ask_question', 'a1', JSON.stringify({ question: 'q', answer: 'x' }), T2),
];

/** 系统提示（error）位于中间 */
const errorMidMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'hi', created_at: T0 }),
  msg({ id: 'err1', message_kind: 'error', content_text: '视觉识别失败', created_at: T1 }),
  msg({ id: 'a1', content_text: 'done', created_at: T3 }),
];

/** ask_question 结果卡片位于中间 */
const askMidMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'ask', created_at: T0 }),
  toolCall('tc-ask', 'ask_question', 'a1', { question: 'q', options: ['x'] }, T1),
  toolResult('res-ask', 'ask_question', 'a1', JSON.stringify({ question: 'q', answer: 'x' }), T2),
  msg({ id: 'a1', content_text: 'done', created_at: T3 }),
];

/** spawn_session 独立结果卡片位于中间 */
const standaloneMidMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'spawn', created_at: T0 }),
  toolCall('tc-spawn', 'spawn_session', 's1', { role: 'worker' }, T1),
  toolResult('res-spawn', 'spawn_session', 's1', JSON.stringify({ status: 'completed', summary: 'done' }), T2),
  msg({ id: 'a1', content_text: 'done', created_at: T3 }),
];

/** 合并卡片 + 文件聚合卡片同场：用于锁定「关闭时两张卡片仍渲染各自时间戳」 */
const mergedAndFileMessages: ChatMessageDTO[] = [
  msg({ id: 'u1', role: 'user', content_text: 'go', created_at: T0 }),
  toolCall('entry1-tool-0', 'bash', 'c1', { command: 'a' }, T1),
  toolResult('res-c1', 'bash', 'c1', 'A', T2),
  toolCall('entry1-tool-1', 'bash', 'c2', { command: 'b' }, T3),
  toolResult('res-c2', 'bash', 'c2', 'B', T4),
  toolCall('entry2-tool-0', 'write', 'w1', { path: 'a.ts', content: 'x' }, T4),
  toolResult('res-w1', 'write', 'w1', 'written', T5),
  msg({ id: 'a1', content_text: 'done', created_at: T5 }),
];

interface RenderOptions {
  messages: ChatMessageDTO[];
  hasMore?: boolean;
  hideChatTimestamps?: boolean;
}

function element({ messages, hasMore = false, hideChatTimestamps = false }: RenderOptions, queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <WebSocketProvider>
        <TabChat
          messages={messages}
          hasMore={hasMore}
          loadingMore={false}
          onLoadMore={() => {}}
          onSend={async () => {}}
          onStop={() => {}}
          sending={false}
          runtimeStatus="idle"
          selectedSessionId={SESSION_ID}
          hideChatTimestamps={hideChatTimestamps}
        />
      </WebSocketProvider>
    </QueryClientProvider>
  );
}

async function renderTabChat(options: RenderOptions) {
  client = makeClient();
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(element(options, client!));
  });
}

async function rerenderTabChat(options: RenderOptions) {
  await act(async () => {
    root!.render(element(options, client!));
  });
}

const timestamps = () =>
  Array.from(container!.querySelectorAll('[data-testid="message-timestamp"]')).map((el) => el.textContent);

const fmt = (iso: string) => new Date(iso).toLocaleTimeString();

describe('隐藏对话框时间戳（TabChat）', () => {
  test('关闭时：所有消息都显示时间戳，行为不变（含工具卡片）', async () => {
    await renderTabChat({ messages: basicMessages });

    expect(container!.querySelector('[data-testid="tool-call-card"]')).not.toBeNull();
    expect(timestamps()).toEqual([fmt(T0), fmt(T1), fmt(T3)]);
  });

  test('开启时：仅第一条与最后一条消息显示时间戳，中间的工具卡片被隐藏', async () => {
    await renderTabChat({ messages: basicMessages, hideChatTimestamps: true });

    expect(timestamps()).toEqual([fmt(T0), fmt(T3)]);
  });

  test('开启 + 历史未加载完（hasMore）：顶部不显示，仅最后一条显示', async () => {
    await renderTabChat({ messages: basicMessages, hideChatTimestamps: true, hasMore: true });

    expect(timestamps()).toEqual([fmt(T3)]);
  });

  test('开启 + 单条消息：首尾同一条，只显示一次', async () => {
    await renderTabChat({
      messages: [msg({ id: 'only', content_text: 'hi', created_at: T0 })],
      hideChatTimestamps: true,
    });

    expect(timestamps()).toEqual([fmt(T0)]);
  });

  test('开启 + 合并卡片承载末条结果：卡片显示末条成员结果的时间，而非锚点时间', async () => {
    await renderTabChat({ messages: mergedMessages, hideChatTimestamps: true });

    expect(container!.querySelector('[data-testid="merged-tool-card"]')).not.toBeNull();
    // 锚点是 T1，但最后一条消息是 res-c2（T4）
    expect(timestamps()).toEqual([fmt(T0), fmt(T4)]);
  });

  test('开启 + 文件聚合卡片位于中间：其时间戳被隐藏', async () => {
    await renderTabChat({ messages: fileMidMessages, hideChatTimestamps: true });

    expect(container!.querySelector('[data-testid="tool-group-card"]')).not.toBeNull();
    expect(timestamps()).toEqual([fmt(T0), fmt(T5)]);
  });

  test('开启 + 文件聚合卡片承载末条结果：卡片显示结果时间', async () => {
    await renderTabChat({ messages: fileTailMessages, hideChatTimestamps: true });

    expect(timestamps()).toEqual([fmt(T0), fmt(T2)]);
  });

  test('关闭时：合并卡片与文件聚合卡片各自的时间戳都显示（undefined = 默认渲染）', async () => {
    await renderTabChat({ messages: mergedAndFileMessages });

    expect(container!.querySelector('[data-testid="merged-tool-card"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="tool-group-card"]')).not.toBeNull();
    expect(timestamps()).toEqual([fmt(T0), fmt(T1), fmt(T4), fmt(T5)]);
  });

  test('开启 + 单条调用且末条是其结果：卡片显示结果时间（被承载的结果参与首尾判断）', async () => {
    await renderTabChat({ messages: singleCallTailMessages, hideChatTimestamps: true });

    expect(timestamps()).toEqual([fmt(T0), fmt(T2)]);
  });

  test('开启 + 末条是独立结果卡片（spawn_session）：只显示一次，不重复', async () => {
    await renderTabChat({ messages: standaloneTailMessages, hideChatTimestamps: true });

    expect(container!.querySelector('[data-testid="standalone-result-card"]')).not.toBeNull();
    expect(timestamps()).toEqual([fmt(T0), fmt(T2)]);
  });

  test('开启 + 末条是 ask_question 结果卡片：只显示一次，不重复', async () => {
    await renderTabChat({ messages: askTailMessages, hideChatTimestamps: true });

    expect(timestamps()).toEqual([fmt(T0), fmt(T2)]);
  });

  test('开启 + 系统提示位于中间：其时间戳被隐藏', async () => {
    await renderTabChat({ messages: errorMidMessages, hideChatTimestamps: true });

    expect(container!.textContent).toContain('视觉识别失败');
    expect(timestamps()).toEqual([fmt(T0), fmt(T3)]);
  });

  test('开启 + ask_question 结果卡片位于中间：其时间戳被隐藏', async () => {
    await renderTabChat({ messages: askMidMessages, hideChatTimestamps: true });

    expect(timestamps()).toEqual([fmt(T0), fmt(T3)]);
  });

  test('开启 + spawn_session 独立结果卡片位于中间：其时间戳被隐藏', async () => {
    await renderTabChat({ messages: standaloneMidMessages, hideChatTimestamps: true });

    expect(container!.querySelector('[data-testid="standalone-result-card"]')).not.toBeNull();
    expect(timestamps()).toEqual([fmt(T0), fmt(T3)]);
  });

  test('开启 + 空会话：占位消息不显示时间戳；关闭时行为不变（仍显示）', async () => {
    await renderTabChat({ messages: [], hideChatTimestamps: true });
    expect(timestamps()).toEqual([]);

    await rerenderTabChat({ messages: [], hideChatTimestamps: false });
    expect(timestamps()).toHaveLength(1);
  });

  test('切换设置即时生效：不改数据、只翻转 prop，可见时间戳随之变化', async () => {
    await renderTabChat({ messages: basicMessages, hideChatTimestamps: false });
    expect(timestamps()).toHaveLength(3);

    await rerenderTabChat({ messages: basicMessages, hideChatTimestamps: true });
    expect(timestamps()).toEqual([fmt(T0), fmt(T3)]);

    await rerenderTabChat({ messages: basicMessages, hideChatTimestamps: false });
    expect(timestamps()).toHaveLength(3);
  });
});
