import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { WebSocketProvider, useWebSocket } from '../lib/ws-provider';
import AskQuestionNotifier from './AskQuestionNotifier';
import { TOKEN_STORAGE_KEY } from '../lib/auth-session';
import type { AskQuestionPendingPayload } from '@piplus/shared';

// ask_question 通知链路验收：真实渲染 WebSocketProvider + AskQuestionNotifier，
// 用假 WebSocket 驱动 ask_question_pending、用假 Notification 断言系统通知。
// 覆盖：触发条件（非活跃会话 / 失焦）、点击跳转、去重、标题前缀、无事件通路时的补偿拉取。

type Listener = (event?: MessageEvent | Event) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  private listeners = new Map<string, Listener[]>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: Listener) {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent('close');
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent('open');
  }

  dispatchEvent(type: string, event?: MessageEvent | Event) {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  /** 服务端下发一条事件（模拟 socketHub 投递）。 */
  emitMessage(payload: AskQuestionPendingPayload) {
    this.dispatchEvent('message', {
      data: JSON.stringify({
        kind: 'event',
        type: 'ask_question_pending',
        timestamp: new Date().toISOString(),
        scope: { session_id: payload.sessionId },
        payload,
      }),
    } as MessageEvent);
  }
}

class FakeNotification {
  static permission: NotificationPermission = 'granted';
  /** 已构造的通知实例：组件在构造后才绑定 onclick，因此断言直接读实例。 */
  static instances: FakeNotification[] = [];
  static requestPermission = async () => 'granted' as NotificationPermission;

  onclick: (() => void) | null = null;
  closed = false;

  constructor(public title: string, public options?: NotificationOptions) {
    FakeNotification.instances.push(this);
  }

  close() {
    this.closed = true;
  }
}

const SESSION_ID = 'sess_target';
const OTHER_SESSION_ID = 'sess_other';
const SESSION_TITLE = '目标会话';

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;
const originalNavigator = globalThis.navigator;
const originalNotification = globalThis.Notification;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalCustomEvent = globalThis.CustomEvent;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient;
let focused = true;
/** /api/v1/ask-pending 返回内容：补偿拉取的输入。 */
let globalPending: AskQuestionPendingPayload[] = [];
let askPendingFetchCalls = 0;
let navigated: string[] = [];
let focusCalls = 0;
/** 最新一次渲染拿到的 context（用于测试里清理 pending）。 */
let latestContext: ReturnType<typeof useWebSocket> | null = null;

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

function Probe() {
  latestContext = useWebSocket();
  return null;
}

function setupGlobals() {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  globalThis.CustomEvent = window.CustomEvent as unknown as typeof CustomEvent;
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  FakeNotification.instances = [];
  FakeNotification.permission = 'granted';
  globalThis.Notification = FakeNotification as unknown as typeof Notification;
  // notification.ts 的 isNotificationSupported() 检查 'Notification' in window
  (window as unknown as { Notification: unknown }).Notification = FakeNotification;

  // 焦点可切换：document.hasFocus() 现取，visibilityState 固定 visible 让 hasFocus 分支生效
  Object.defineProperty(window.document, 'visibilityState', { configurable: true, get: () => 'visible' });
  (window.document as unknown as { hasFocus: () => boolean }).hasFocus = () => focused;
  // window.focus() 是点击通知时“聚焦窗口”的被调用目标（happy-dom 下无副作用，用计数断言）
  (window as unknown as { focus: () => void }).focus = () => { focusCalls += 1; };

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/v1/auth/status')) return jsonResponse({ requiresPassword: true });
    if (url.includes('/api/v1/auth/check')) return jsonResponse({ ok: true, user: { id: 'local-user', name: 'local' } });
    if (url.includes('/api/v1/ask-pending')) {
      askPendingFetchCalls += 1;
      return jsonResponse({ pending: globalPending });
    }
    return { ok: false } as unknown as Response;
  }) as typeof fetch;

  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'tok-initial');
  window.localStorage.setItem('pi-system-notifications', 'true');
  window.document.title = 'PiPlus';
}

beforeAll(() => {
  setupGlobals();
});

afterAll(async () => {
  await flush();
  await flush();
  if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
  else globalThis.window = originalWindow;
  if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
  else globalThis.document = originalDocument;
  if (originalWebSocket === undefined) delete (globalThis as { WebSocket?: unknown }).WebSocket;
  else globalThis.WebSocket = originalWebSocket;
  if (originalNotification === undefined) delete (globalThis as { Notification?: unknown }).Notification;
  else globalThis.Notification = originalNotification;
  globalThis.fetch = originalFetch;
  (globalThis as { navigator?: unknown }).navigator = originalNavigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
  globalThis.CustomEvent = originalCustomEvent;
});

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeNotification.instances = [];
  FakeNotification.permission = 'granted';
  globalPending = [];
  askPendingFetchCalls = 0;
  navigated = [];
  focusCalls = 0;
  latestContext = null;
  focused = true;
  window.localStorage.setItem(TOKEN_STORAGE_KEY, 'tok-initial');
  window.localStorage.setItem('pi-system-notifications', 'true');
  window.document.title = 'PiPlus';
});

afterEach(async () => {
  if (root) {
    await act(async () => { root!.unmount(); });
    root = null;
  }
  container?.remove();
  container = null;
  await flush();
});

function renderNotifier(activeSessionId: string | null = OTHER_SESSION_ID) {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  queryClient.setQueryData(['tree'], {
    projects: [{
      id: 'proj_1',
      name: 'P',
      sessions: [{ id: SESSION_ID, title: SESSION_TITLE, role_template_key: 'planner', children: [] }],
    }],
  });
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <WebSocketProvider>
          <Probe />
          <AskQuestionNotifier
            activeSessionId={activeSessionId}
            onNavigateSession={(sessionId) => { navigated.push(sessionId); }}
          />
        </WebSocketProvider>
      </QueryClientProvider>,
    );
  });
}

/** 等登录态解析 + 建连 + onOpen（含补偿拉取）落定。 */
async function connectSocket(): Promise<FakeWebSocket> {
  await act(async () => { await flush(); await flush(); });
  const socket = FakeWebSocket.instances[0]!;
  await act(async () => { socket.open(); await flush(); await flush(); });
  return socket;
}

function toastTexts(): string[] {
  return Array.from(container?.querySelectorAll('[role="button"]') ?? []).map((el) => el.textContent ?? '');
}

describe('AskQuestionNotifier 通知触发条件', () => {
  test('非活跃会话的 pending → 系统通知 + toast + 标题前缀', async () => {
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '要用哪个数据库？', options: ['PG'] });
      await flush();
    });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.title).toContain(SESSION_TITLE);
    expect(FakeNotification.instances[0]!.options?.body).toBe('要用哪个数据库？');
    expect(FakeNotification.instances[0]!.options?.silent).toBe(true); // 用户明确不要声音提示
    expect(toastTexts().some((t) => t.includes('要用哪个数据库？'))).toBe(true);
    expect(globalThis.document.title).toBe('(1 条待回答) PiPlus');
  });

  test('当前激活会话 + 窗口聚焦 → 不通知（但仍是待回答未读状态）', async () => {
    renderNotifier(SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '要用哪个数据库？', options: ['PG'] });
      await flush();
    });

    expect(FakeNotification.instances).toHaveLength(0);
    expect(toastTexts()).toHaveLength(0);
    expect(globalThis.document.title).toBe('(1 条待回答) PiPlus');
  });

  test('当前激活会话但窗口失焦 → 通知', async () => {
    renderNotifier(SESSION_ID);
    const socket = await connectSocket();
    focused = false;

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '失焦也要提醒', options: [] });
      await flush();
    });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.options?.body).toBe('失焦也要提醒');
  });

  test('同一 questionId 重复到达 → 只通知一次', async () => {
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();
    const payload = { questionId: 'q1', sessionId: SESSION_ID, question: '重复推送', options: [] };

    await act(async () => {
      socket.emitMessage(payload);
      socket.emitMessage(payload);
      await flush();
    });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(toastTexts()).toHaveLength(1);
  });
});

describe('AskQuestionNotifier 交互', () => {
  test('点击系统通知 → 聚焦窗口 + 跳转到提问会话', async () => {
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '点我跳转', options: [] });
      await flush();
    });
    // 组件在构造后赋值 onclick：直接读实例
    const instance = FakeNotification.instances[0]!;
    expect(instance.onclick).not.toBeNull();
    await act(async () => { (instance.onclick as () => void)(); });

    expect(navigated).toEqual([SESSION_ID]);
    expect(focusCalls).toBe(1); // 聚焦窗口
  });

  test('点击 toast → 跳转并关闭浮层', async () => {
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '点我跳转', options: [] });
      await flush();
    });
    const toast = container!.querySelector('[role="button"]') as HTMLElement;
    await act(async () => {
      toast.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await flush();
    });

    expect(navigated).toEqual([SESSION_ID]);
    expect(focusCalls).toBe(1);
    expect(toastTexts()).toHaveLength(0);
  });

  test('回答完毕（clearAskPending）→ 标题前缀还原', async () => {
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '稍后回答', options: [] });
      await flush();
    });
    expect(globalThis.document.title).toBe('(1 条待回答) PiPlus');

    await act(async () => {
      latestContext!.clearAskPending?.('q1');
      await flush();
    });
    expect(globalThis.document.title).toBe('PiPlus');
  });

  test('系统通知权限被拒 → 静默降级为应用内 toast', async () => {
    FakeNotification.permission = 'denied';
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '无权限也要提示', options: [] });
      await flush();
    });

    expect(FakeNotification.instances).toHaveLength(0);
    expect(toastTexts().some((t) => t.includes('无权限也要提示'))).toBe(true);
    expect(globalThis.document.title).toBe('(1 条待回答) PiPlus');
  });

  test('组件卸载 → 标题前缀还原，不给登录页留残留', async () => {
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q1', sessionId: SESSION_ID, question: '卸载前待回答', options: [] });
      await flush();
    });
    expect(globalThis.document.title).toBe('(1 条待回答) PiPlus');

    await act(async () => { root!.unmount(); });
    root = null;
    expect(globalThis.document.title).toBe('PiPlus');
  });
});

describe('AskQuestionNotifier 无事件通路时的补偿拉取', () => {
  test('挂载时拉取全局 pending：即使没有收到 WS 事件也通知', async () => {
    globalPending = [{ questionId: 'q_lost', sessionId: SESSION_ID, question: '断线期间错过的提问', options: [] }];
    renderNotifier(OTHER_SESSION_ID);
    await connectSocket();

    expect(askPendingFetchCalls).toBeGreaterThanOrEqual(1);
    expect(FakeNotification.instances).toHaveLength(1);
    expect(FakeNotification.instances[0]!.options?.body).toBe('断线期间错过的提问');
  });

  test('WS 重连（onOpen）再次补偿拉取', async () => {
    renderNotifier(OTHER_SESSION_ID);
    await connectSocket();
    const callsAfterFirstConnect = askPendingFetchCalls;

    // 断线期间产生提问，重连时补回
    globalPending = [{ questionId: 'q_reconnect', sessionId: SESSION_ID, question: '重连后补齐', options: [] }];
    const socket = FakeWebSocket.instances[0]!;
    await act(async () => {
      socket.open();
      await flush();
      await flush();
    });

    expect(askPendingFetchCalls).toBeGreaterThan(callsAfterFirstConnect);
    expect(FakeNotification.instances.some((n) => n.options?.body === '重连后补齐')).toBe(true);
  });

  test('窗口重新聚焦时补偿拉取', async () => {
    renderNotifier(OTHER_SESSION_ID);
    await connectSocket();
    const callsAfterFirstConnect = askPendingFetchCalls;

    globalPending = [{ questionId: 'q_focus', sessionId: SESSION_ID, question: '重新聚焦后补齐', options: [] }];
    await act(async () => {
      window.dispatchEvent(new window.Event('focus'));
      await flush();
      await flush();
    });

    expect(askPendingFetchCalls).toBeGreaterThan(callsAfterFirstConnect);
    expect(FakeNotification.instances.some((n) => n.options?.body === '重新聚焦后补齐')).toBe(true);
  });

  test('补偿拉取与实时事件重叠时不重复通知', async () => {
    globalPending = [{ questionId: 'q_dup', sessionId: SESSION_ID, question: '同一条', options: [] }];
    renderNotifier(OTHER_SESSION_ID);
    const socket = await connectSocket();

    await act(async () => {
      socket.emitMessage({ questionId: 'q_dup', sessionId: SESSION_ID, question: '同一条', options: [] });
      await flush();
    });

    expect(FakeNotification.instances).toHaveLength(1);
    expect(toastTexts()).toHaveLength(1);
  });
});
