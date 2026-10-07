import { afterAll, afterEach, beforeAll, describe, expect, jest, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import { OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS, useOptimisticUserMessages } from './use-optimistic-user-messages';

// R6：乐观用户消息的移除时机。
// 旧实现「发送后固定 60s 删除」会在首轮回答超过 60s 时把用户刚发的消息抹掉（要等 complete 才回来）。
// 新语义：运行中绝不移除；仅在会话非 running（idle 兜底）计时，或 running→idle 转换时清理。

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
    act(() => { root!.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
  jest.useRealTimers();
});

type HookApi = ReturnType<typeof useOptimisticUserMessages>;

function message(id: string): ChatMessageDTO {
  return {
    id,
    role: 'user',
    message_kind: 'normal',
    source_session_id: null,
    content_text: id,
    created_at: new Date().toISOString(),
  } as ChatMessageDTO;
}

interface ProbeProps {
  sessionId: string | null;
  isRunning: boolean;
  messages: ChatMessageDTO[];
  onApi: (api: HookApi) => void;
}

function Probe({ sessionId, isRunning, messages, onApi }: ProbeProps) {
  const api = useOptimisticUserMessages({ sessionId, isRunning, messages });
  onApi(api);
  return <div data-testid="pending-ids">{api.pendingUserMessages.map((m) => m.id).join(',')}</div>;
}

function renderProbe(props: ProbeProps) {
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<Probe {...props} />);
  });
}

function renderProbeWithProps(initial: ProbeProps) {
  let api: HookApi | null = null;
  let current = initial;
  const setProps = (next: Partial<ProbeProps>) => {
    current = { ...current, ...next };
    act(() => {
      root!.render(<Probe {...current} onApi={(a) => { api = a; }} />);
    });
  };
  renderProbe({ ...initial, onApi: (a) => { api = a; } });
  return {
    get api() {
      if (!api) throw new Error('api not ready');
      return api;
    },
    setProps,
  };
}

function pendingIds(): string {
  return container!.querySelector('[data-testid="pending-ids"]')!.textContent ?? '';
}

/** 推进假定时器；React setState 由定时器回调触发，需包在 act 内。 */
function advance(ms: number) {
  act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe('useOptimisticUserMessages', () => {
  test('运行中（running）超过兜底时长也不移除乐观消息', () => {
    jest.useFakeTimers();
    const { api } = renderProbeWithProps({ sessionId: 's1', isRunning: true, messages: [], onApi: () => {} });

    act(() => { api.addPendingUserMessage(message('optimistic-1')); });
    expect(pendingIds()).toBe('optimistic-1');

    advance(OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS * 3);
    expect(pendingIds()).toBe('optimistic-1');
  });

  test('非 running 时兜底：超过兜底时长仍未确认才移除', () => {
    jest.useFakeTimers();
    const { api } = renderProbeWithProps({ sessionId: 's1', isRunning: false, messages: [], onApi: () => {} });

    act(() => { api.addPendingUserMessage(message('optimistic-1')); });
    advance(OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS - 1);
    expect(pendingIds()).toBe('optimistic-1');

    advance(1);
    expect(pendingIds()).toBe('');
  });

  test('running→idle 转换（run 结束）时立即清理，不依赖兜底计时', () => {
    jest.useFakeTimers();
    const { api, setProps } = renderProbeWithProps({ sessionId: 's1', isRunning: true, messages: [], onApi: () => {} });

    act(() => { api.addPendingUserMessage(message('optimistic-1')); });
    setProps({ isRunning: false });
    expect(pendingIds()).toBe('');
  });

  test('消息刷新（invalidate 落库）会重置非 running 的兜底计时', () => {
    jest.useFakeTimers();
    const { api, setProps } = renderProbeWithProps({ sessionId: 's1', isRunning: false, messages: [], onApi: () => {} });

    act(() => { api.addPendingUserMessage(message('optimistic-1')); });
    advance(OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS - 1000);
    expect(pendingIds()).toBe('optimistic-1');

    // 消息列表刷新（同会话任何 invalidate 的落库结果）
    setProps({ messages: [message('real-user-1')] });
    advance(OPTIMISTIC_MESSAGE_IDLE_FALLBACK_MS - 1000);
    expect(pendingIds()).toBe('optimistic-1');

    advance(1000);
    expect(pendingIds()).toBe('');
  });

  test('切换会话清空乐观消息（跨会话 reconcile 不匹配）', () => {
    jest.useFakeTimers();
    const { api, setProps } = renderProbeWithProps({ sessionId: 's1', isRunning: true, messages: [], onApi: () => {} });

    act(() => { api.addPendingUserMessage(message('optimistic-1')); });
    expect(pendingIds()).toBe('optimistic-1');

    setProps({ sessionId: 's2' });
    expect(pendingIds()).toBe('');
  });

  test('发送失败可显式移除单条乐观消息', () => {
    jest.useFakeTimers();
    const { api } = renderProbeWithProps({ sessionId: 's1', isRunning: true, messages: [], onApi: () => {} });

    act(() => {
      api.addPendingUserMessage(message('optimistic-1'));
      api.addPendingUserMessage(message('optimistic-2'));
    });
    act(() => { api.removePendingUserMessage('optimistic-1'); });
    expect(pendingIds()).toBe('optimistic-2');
  });
});
