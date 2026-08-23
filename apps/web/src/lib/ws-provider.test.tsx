import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { WebSocketProvider, useWebSocketConnected } from './ws-provider';
import { TOKEN_STORAGE_KEY } from './auth-session';

// 验收场景（reviewer 🔴）：4401 登出停摆后，用户重新登录必须能重建 WS 连接
// 且 hello 帧携带最新 token。通过真实渲染 WebSocketProvider 并驱动登录态查询缓存完成。

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
  closeCalls = 0;
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
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close');
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open');
  }

  dispatch(type: string, event?: MessageEvent | Event) {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function jsonResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

describe('WebSocketProvider reconnect after re-login', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalWebSocket = globalThis.WebSocket;
  const originalFetch = globalThis.fetch;
  const originalNavigator = globalThis.navigator;
  const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  const originalCustomEvent = globalThis.CustomEvent;

  let window: Window;
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let queryClient: QueryClient;

  // 全局 DOM 环境在 beforeAll/afterAll 管理：react-query 的异步通知可能在
  // afterEach 之后仍触发 react-dom 对 window 的访问，逐测还原会导致 window 为 undefined。
  function setupGlobals() {
    window = new Window({ url: 'https://demo.example.com/' });
    globalThis.window = window as unknown as Window & typeof globalThis;
    globalThis.document = window.document as unknown as Document;
    (globalThis as { navigator?: unknown }).navigator = window.navigator;
    // ws-client 在登出时 new CustomEvent(...)：必须用同一 Window 的 CustomEvent，
    // 否则 happy-dom 的 dispatchEvent 会因跨 realm 实例校验而抛错。
    globalThis.CustomEvent = window.CustomEvent as unknown as typeof CustomEvent;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    // Mock API：status 声明需要密码；check 放行任意 token（refresh 走失败路径保持确定性）。
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/v1/auth/status')) return jsonResponse({ requiresPassword: true });
      if (url.includes('/api/v1/auth/check')) return jsonResponse({ ok: true, user: { id: 'local-user', name: 'local' } });
      if (url.includes('/api/v1/auth/refresh')) return { ok: false } as unknown as Response;
      return { ok: false } as unknown as Response;
    }) as typeof fetch;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'tok-initial');
  }

  beforeAll(() => {
    setupGlobals();
  });

  afterAll(async () => {
    await flush();
    await flush();
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.WebSocket = originalWebSocket;
    globalThis.fetch = originalFetch;
    (globalThis as { navigator?: unknown }).navigator = originalNavigator;
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
    globalThis.CustomEvent = originalCustomEvent;
  });

  function renderProvider(): { connectedValues: boolean[] } {
    const connectedValues: boolean[] = [];
    function Probe() {
      connectedValues.push(useWebSocketConnected());
      return null;
    }
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    container = (globalThis.document as Document).createElement('div');
    (globalThis.document as Document).body.appendChild(container);
    root = createRoot(container);
    // 同步包一层 act：确保首次渲染的 effects 在返回前已提交
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <WebSocketProvider>
            <Probe />
          </WebSocketProvider>
        </QueryClientProvider>,
      );
    });
    return { connectedValues };
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'tok-initial');
  });

  afterEach(async () => {
    if (root) {
      await act(async () => {
        root!.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    await flush();
  });

  test('4401 logout halts the socket; re-login rebuilds it with a fresh hello token', async () => {
    const { connectedValues } = renderProvider();

    // 登录态查询解析完成后（isLoggedIn=true）才建连：恰好一个 socket
    await act(async () => {
      await flush();
      await flush();
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    const first = FakeWebSocket.instances[0]!;
    await act(async () => {
      first.open();
      await flush();
    });
    expect(first.sent.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(first.sent[0]!)).toMatchObject({
      kind: 'client',
      type: 'hello',
      payload: { token: 'tok-initial' },
    });
    expect(connectedValues.at(-1)).toBe(true);

    // 服务端 4401 关闭：不再重连、广播登出，provider 因 isLoggedIn 翻转关闭死连接
    await act(async () => {
      first.dispatch('close', { code: 4401 });
      await flush();
      await flush();
    });
    expect(FakeWebSocket.instances).toHaveLength(1); // 无重连
    expect(first.closeCalls).toBeGreaterThanOrEqual(1); // 死连接被主动关闭
    expect(connectedValues.at(-1)).toBe(false);

    // 用户重新登录：写入新的 auth session 查询数据 + 新 token
    // （等价于 useLoginMutation.onSuccess 的 setToken + setQueryData）
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'tok-fresh');
    await act(async () => {
      queryClient.setQueryData(['auth', 'session'], { ok: true, user: { id: 'local-user', name: 'local' }, token: 'tok-fresh' });
      await flush();
      await flush();
    });

    // 重建：出现第二个 socket，hello 携带新 token
    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1]!;
    await act(async () => {
      second.open();
      await flush();
    });
    expect(JSON.parse(second.sent[0]!)).toMatchObject({
      kind: 'client',
      type: 'hello',
      payload: { token: 'tok-fresh' },
    });
    expect(connectedValues.at(-1)).toBe(true);
  });
});
