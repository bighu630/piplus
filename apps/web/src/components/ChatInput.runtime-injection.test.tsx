import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import ChatInput from './ChatInput';
import { SESSION_DRAFTS_STORAGE_KEY } from '../lib/session-drafts';

// 「运行中允许插话（steer）」的前端交互：
// - 运行中 textarea 始终可输入（开关关闭也允许编辑，只是不能发）
// - 运行中 + 开关开 → 发送按钮文案「插入」+ 黄色 + 可发送
// - 运行中 + 开关关 → 发送按钮禁用（即使草稿非空）
//
// 复用 SettingsPanel.timestamps.test.tsx 的 harness（happy-dom + createRoot/act + 全局 fetch 桩）。
// 草稿通过 localStorage 预置：happy-dom 无法可靠驱动 React 的 textarea onChange，
// 但 ChatInput 挂载时会从 session-drafts 读草稿，等价于「用户已输入内容」。

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalFetch = globalThis.fetch;
const originalLocalStorage = (globalThis as { localStorage?: unknown }).localStorage;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

const SESSION_ID = 'session-chatinput-injection';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { localStorage?: unknown }).localStorage = window.localStorage;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/commands')) return jsonResponse({ commands: [] });
    return jsonResponse({});
  }) as typeof fetch;
});

afterAll(async () => {
  // 同 afterEach：恢复全局 window 前再给 scheduler 一轮机会，避免跨文件崩溃
  await new Promise((resolve) => setTimeout(resolve, 0));
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { localStorage?: unknown }).localStorage = originalLocalStorage;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
});

afterEach(async () => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  // 排空 React scheduler 的延迟回调（此时 globalThis.window 仍指向本文件的 happy-dom 实例）：
  // 否则回调会落到下一个测试文件恢复全局后的 window=undefined 上，抛 "window.event" 未定义。
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  container?.remove();
  container = null;
  window.localStorage.clear();
});

function seedDraft(text: string) {
  window.localStorage.setItem(
    SESSION_DRAFTS_STORAGE_KEY,
    JSON.stringify({ [SESSION_ID]: { text, updatedAt: Date.now() } }),
  );
}

async function renderInput(opts: { isRunning: boolean; allowInjection?: boolean; draft?: string }) {
  if (opts.draft) seedDraft(opts.draft);
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const onSendCalls: Array<{ content: string; attachments: unknown[] }> = [];
  const onSend = async (content: string, attachments: unknown[]) => {
    onSendCalls.push({ content, attachments });
  };
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <ChatInput
          onSend={onSend as never}
          onStop={() => {}}
          sending={false}
          isRunning={opts.isRunning}
          isStopping={false}
          isAsking={false}
          sendShortcutMode="enter"
          currentModelSupportsImages={true}
          visionRelayEnabled={false}
          wsConnected={true}
          selectedSessionId={SESSION_ID}
          isMobile={false}
          allowInjection={opts.allowInjection}
        />
      </QueryClientProvider>,
    );
  });
  // 等草稿 effect / commands query 落定，避免跨用例的 act 告警
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return { onSendCalls };
}

async function clickSend() {
  await act(async () => {
    sendButton().click();
  });
}

const textarea = () => container!.querySelector('textarea') as HTMLTextAreaElement;
const sendButton = () =>
  Array.from(container!.querySelectorAll('button')).find((b) => /发送|插入/.test(b.textContent ?? '')) as HTMLButtonElement;

describe('ChatInput 运行中插话交互', () => {
  test('运行中 + 开关关闭：输入框可编辑，发送按钮禁用（文案仍为「发送」）', async () => {
    await renderInput({ isRunning: true, allowInjection: false, draft: '草稿' });

    expect(textarea().disabled).toBe(false);
    expect(textarea().value).toBe('草稿');
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().textContent).toContain('发送');
    expect(sendButton().className).toContain('bg-blue-600');
  });

  test('运行中 + 开关开启：发送按钮变「插入」+ 黄色，且草稿非空时可点击', async () => {
    await renderInput({ isRunning: true, allowInjection: true, draft: '插话内容' });

    expect(textarea().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent).toContain('插入');
    expect(sendButton().className).toContain('bg-amber-500');
  });

  test('运行中 + 开关开启：点击「插入」确实发送草稿', async () => {
    const { onSendCalls } = await renderInput({ isRunning: true, allowInjection: true, draft: '插话内容' });

    await clickSend();

    expect(onSendCalls).toEqual([{ content: '插话内容', attachments: [] }]);
  });

  test('运行中 + 开关关闭：点击发送按钮不会发出（按钮已禁用）', async () => {
    const { onSendCalls } = await renderInput({ isRunning: true, allowInjection: false, draft: '草稿' });

    await clickSend();

    expect(onSendCalls).toHaveLength(0);
    // 草稿未被清空（未走乐观清空路径）
    expect(textarea().value).toBe('草稿');
  });

  test('运行中 + 开关开启但草稿为空：仍为「插入」且禁用', async () => {
    await renderInput({ isRunning: true, allowInjection: true });

    expect(sendButton().textContent).toContain('插入');
    expect(sendButton().disabled).toBe(true);
  });

  test('空闲状态：发送按钮为蓝色「发送」，textarea 可编辑（未回归）', async () => {
    const { onSendCalls } = await renderInput({ isRunning: false, allowInjection: false, draft: '正常消息' });

    expect(textarea().disabled).toBe(false);
    expect(sendButton().disabled).toBe(false);
    expect(sendButton().textContent).toContain('发送');
    expect(sendButton().className).toContain('bg-blue-600');

    await clickSend();
    expect(onSendCalls).toEqual([{ content: '正常消息', attachments: [] }]);
  });

  // 未覆盖：Enter 快捷键守卫（handleSubmit 开头的 isRunning && !allowInjection 早返回）。
  // 原因与本仓 TabChat.test.tsx 记录的一致：happy-dom + React 19 下 dispatchEvent 驱动不了
  // onKeyDown（实测 onInput 可、onChange/onKeyDown 不行）。发送被禁已由「按钮 disabled + 点击不发出」覆盖。
});
