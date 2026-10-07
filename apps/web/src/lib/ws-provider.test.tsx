import { afterEach, beforeAll, afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import { WebSocketProvider, useWebSocket, useWebSocketConnected, useChatStream } from './ws-provider';
import { TOKEN_STORAGE_KEY } from './auth-session';
import { SYSTEM_NOTIFICATIONS_STORAGE_KEY } from './notification';

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

// 补偿拉取（GET /api/v1/ask-pending）的可控响应与调用计数
let askPendingResponse: Array<Record<string, unknown>> = [];
let askPendingCalls = 0;

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
      if (url.includes('/api/v1/ask-pending')) {
        askPendingCalls += 1;
        return jsonResponse({ pending: askPendingResponse });
      }
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

  /** 渲染自定义探针（与 renderProvider 相同的 Provider/QueryClient 包装）。 */
  function renderNode(node: React.ReactNode) {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    container = (globalThis.document as Document).createElement('div');
    (globalThis.document as Document).body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <WebSocketProvider>{node}</WebSocketProvider>
        </QueryClientProvider>,
      );
    });
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

  // 嵌套 describe：继承父级 beforeAll/afterAll/beforeEach/afterEach 与全局变量（window/document/root/container）
  describe('ask_question 补偿拉取', () => {
    beforeEach(() => {
      askPendingResponse = [];
      askPendingCalls = 0;
    });

    /** 渲染 provider 并收集每次渲染看到的 askingPendingMap。 */
    function renderWithPendingMap(): { maps: Array<Record<string, unknown>> } {
      const maps: Array<Record<string, unknown>> = [];
      function Probe() {
        const ctx = useWebSocket() as unknown as { askingPendingMap: Record<string, unknown> };
        maps.push(ctx.askingPendingMap);
        return null;
      }
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      container = (globalThis.document as Document).createElement('div');
      (globalThis.document as Document).body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <WebSocketProvider>
              <Probe />
            </WebSocketProvider>
          </QueryClientProvider>,
        );
      });
      return { maps };
    }

    test('挂载/重连时拉取全局 ask-pending 并合并进 askingPendingMap（断线期间错过事件的补偿）', async () => {
      askPendingResponse = [{ questionId: 'q1', sessionId: 's1', question: '断线期间错过的提问' }];
      const { maps } = renderWithPendingMap();

      await act(async () => {
        await flush();
        await flush();
      });
      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        await flush();
        await flush();
      });

      expect(askPendingCalls).toBeGreaterThanOrEqual(1);
      expect(maps.at(-1)!.q1).toMatchObject({ questionId: 'q1', sessionId: 's1' });
    });

    test('实时事件与补偿重叠：同一 questionId 只保留一份，不重复写入', async () => {
      askPendingResponse = [{ questionId: 'q1', sessionId: 's1', question: '同一条' }];
      const { maps } = renderWithPendingMap();

      await act(async () => {
        await flush();
        await flush();
      });
      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        socket.dispatch('message', {
          data: JSON.stringify({
            kind: 'event',
            type: 'ask_question_pending',
            timestamp: new Date().toISOString(),
            scope: { session_id: 's1' },
            payload: { questionId: 'q1', sessionId: 's1', question: '同一条' },
          }),
        } as unknown as MessageEvent);
        await flush();
        await flush();
      });

      expect(Object.keys(maps.at(-1)!)).toEqual(['q1']);
    });

    test('登出（4401）清空 askingPendingMap：换号后不残留标题计数/琥珀标记', async () => {
      askPendingResponse = [{ questionId: 'q1', sessionId: 's1', question: '待回答' }];
      const { maps } = renderWithPendingMap();

      await act(async () => {
        await flush();
        await flush();
      });
      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        await flush();
        await flush();
      });
      expect(Object.keys(maps.at(-1)!)).toEqual(['q1']);

      await act(async () => {
        socket.dispatch('close', { code: 4401 });
        await flush();
        await flush();
      });

      expect(maps.at(-1)).toEqual({});
    });
  });

  describe('session.messages_changed 刷新', () => {
    test('收到工具结果落库事件时 invalidate 该会话的 messages 查询', async () => {
      renderProvider();
      await act(async () => {
        await flush();
        await flush();
      });
      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        await flush();
      });

      // 在 onOpen 之后装侦：避免把建连时的既有 invalidate 计入
      const calls: Array<{ queryKey?: unknown[] }> = [];
      const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
      queryClient.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
        calls.push(filters ?? {});
        return originalInvalidate(filters as never);
      }) as typeof queryClient.invalidateQueries;

      await act(async () => {
        socket.dispatch('message', {
          data: JSON.stringify({
            kind: 'event',
            type: 'session.messages_changed',
            timestamp: new Date().toISOString(),
            scope: { session_id: 'sess_tool_1' },
            payload: {},
          }),
        } as unknown as MessageEvent);
        await flush();
      });

      expect(calls).toContainEqual({ queryKey: ['session', 'messages', 'sess_tool_1'] });
    });

    test('工具结果事件不会推进 chat_stream 快照 phase（保持 streaming）', async () => {
      const phases: string[] = [];
      function StreamProbe() {
        const ctx = useWebSocket() as unknown as {
          setSessionContext: (s: string | null, p: string | null, t: string) => void;
        };
        // chat_stream 仅对「当前会话」转发给流式订阅者，测试需要先设定会话上下文
        useEffect(() => {
          ctx.setSessionContext('sess_tool_2', null, 'chat');
        }, []);
        phases.push(useChatStream('sess_tool_2').phase);
        return null;
      }
      queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
      container = (globalThis.document as Document).createElement('div');
      (globalThis.document as Document).body.appendChild(container);
      root = createRoot(container);
      act(() => {
        root!.render(
          <QueryClientProvider client={queryClient}>
            <WebSocketProvider>
              <StreamProbe />
            </WebSocketProvider>
          </QueryClientProvider>,
        );
      });
      await act(async () => {
        await flush();
        await flush();
      });
      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        await flush();
      });

      const dispatch = (body: Record<string, unknown>) => {
        socket.dispatch('message', { data: JSON.stringify(body) } as unknown as MessageEvent);
      };

      // 先建立 streaming 状态（越过 80ms 节流窗口）
      await act(async () => {
        dispatch({ kind: 'chat_stream', phase: 'start', scope: { session_id: 'sess_tool_2' }, payload: {} });
        dispatch({ kind: 'chat_stream', phase: 'delta', scope: { session_id: 'sess_tool_2' }, payload: { delta: 'hi' } });
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(phases.at(-1)).toBe('streaming');

      // 工具结果落库事件只应刷新消息列表，不得把流式 phase 推进为 complete
      await act(async () => {
        dispatch({ kind: 'event', type: 'session.messages_changed', scope: { session_id: 'sess_tool_2' }, payload: {} });
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(phases.at(-1)).toBe('streaming');
    });
  });

  describe('重连后清理残留流式快照（R4）', () => {
    test('断线期间 run 结束（idle 事件丢失）：重连后把 streaming 快照复位并通知订阅者', async () => {
      const snapshots: Array<{ phase: string; streamingContent: string }> = [];
      function StreamProbe() {
        const ctx = useWebSocket() as unknown as {
          setSessionContext: (s: string | null, p: string | null, t: string) => void;
        };
        // chat_stream 仅对「当前会话」转发给流式订阅者，测试需要先设定会话上下文
        useEffect(() => {
          ctx.setSessionContext('sess_reconnect', null, 'chat');
        }, []);
        const snap = useChatStream('sess_reconnect');
        snapshots.push({ phase: snap.phase, streamingContent: snap.streamingContent });
        return null;
      }
      renderNode(<StreamProbe />);
      await act(async () => {
        await flush();
        await flush();
      });

      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        await flush();
      });

      const dispatch = (body: Record<string, unknown>) => {
        socket.dispatch('message', { data: JSON.stringify(body) } as unknown as MessageEvent);
      };

      // 进入流式状态（越过 80ms 节流窗口）
      await act(async () => {
        dispatch({ kind: 'chat_stream', phase: 'start', scope: { session_id: 'sess_reconnect' }, payload: {} });
        dispatch({ kind: 'chat_stream', phase: 'delta', scope: { session_id: 'sess_reconnect' }, payload: { delta: '半截内容' } });
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
      expect(snapshots.at(-1)).toMatchObject({ phase: 'streaming', streamingContent: '半截内容' });

      // 断线：run 在断线期间结束，idle 事件永远不会到达
      const invalidations: Array<{ queryKey?: unknown[] }> = [];
      const originalInvalidate = queryClient.invalidateQueries.bind(queryClient);
      queryClient.invalidateQueries = ((filters?: { queryKey?: unknown[] }) => {
        invalidations.push(filters ?? {});
        return originalInvalidate(filters as never);
      }) as typeof queryClient.invalidateQueries;

      await act(async () => {
        socket.dispatch('close', { code: 1006 });
        await flush();
      });

      // 既有指数退避重连（首次 2000ms）→ 新连接 onOpen
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 2100));
        await flush();
      });
      expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);
      const second = FakeWebSocket.instances[1]!;
      await act(async () => {
        second.open();
        await new Promise((resolve) => setTimeout(resolve, 120));
      });

      // 残留的 streaming 快照被清理（否则半截流式气泡在补拉出完整消息后仍常驻）
      expect(snapshots.at(-1)).toMatchObject({ phase: 'idle', streamingContent: '' });
      // 重连补拉：当前会话消息被 invalidate
      expect(invalidations).toContainEqual({ queryKey: ['session', 'messages', 'sess_reconnect'] });
    });
  });

  describe('订阅被拒（subscription.denied）（R7）', () => {
    class FakeNotification {
      static permission: NotificationPermission = 'granted';
      static instances: FakeNotification[] = [];
      title: string;
      options?: NotificationOptions;
      constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options;
        FakeNotification.instances.push(this);
      }
    }
    const originalNotification = globalThis.Notification;
    let originalWindowNotification: unknown;

    beforeEach(() => {
      FakeNotification.instances = [];
      originalWindowNotification = (window as unknown as { Notification?: unknown }).Notification;
      (window as unknown as { Notification: unknown }).Notification = FakeNotification;
      (globalThis as { Notification?: unknown }).Notification = FakeNotification;
      window.localStorage.setItem(SYSTEM_NOTIFICATIONS_STORAGE_KEY, 'true');
    });

    afterEach(() => {
      (window as unknown as { Notification?: unknown }).Notification = originalWindowNotification;
      (globalThis as { Notification?: unknown }).Notification = originalNotification;
      window.localStorage.removeItem(SYSTEM_NOTIFICATIONS_STORAGE_KEY);
    });

    /** 渲染「当前会话 = sess_denied」的探针并打开连接，返回驱动函数。 */
    async function renderDeniedScenario() {
      function DeniedProbe() {
        const ctx = useWebSocket() as unknown as {
          setSessionContext: (s: string | null, p: string | null, t: string) => void;
        };
        useEffect(() => {
          ctx.setSessionContext('sess_denied', null, 'chat');
        }, []);
        return null;
      }
      renderNode(<DeniedProbe />);
      await act(async () => {
        await flush();
        await flush();
      });

      const socket = FakeWebSocket.instances[0]!;
      await act(async () => {
        socket.open();
        await flush();
      });

      return {
        socket,
        subscribeFrames: () => socket.sent
          .map((raw) => JSON.parse(raw) as { type?: string; payload?: { session_id?: string } })
          .filter((m) => m.type === 'subscribe_session' && m.payload?.session_id === 'sess_denied'),
        deny: () => socket.dispatch('message', {
          data: JSON.stringify({
            kind: 'event',
            type: 'subscription.denied',
            timestamp: new Date().toISOString(),
            payload: { session_id: 'sess_denied' },
          }),
        } as unknown as MessageEvent),
      };
    }

    test('被拒后提示用户并做一次延迟重订阅', async () => {
      const { socket, subscribeFrames, deny } = await renderDeniedScenario();

      // onOpen 已订阅一次
      expect(subscribeFrames()).toHaveLength(1);

      // 第一次被拒：提示用户 + 延迟重订阅
      await act(async () => {
        deny();
        await flush();
      });
      expect(FakeNotification.instances).toHaveLength(1);
      expect(FakeNotification.instances[0]!.title).toContain('订阅');
      expect(FakeNotification.instances[0]!.options?.body).toContain('重试');

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3200));
      });
      expect(subscribeFrames()).toHaveLength(2);
    });

    test('重试仍失败则放弃：给出最终提示且不再重订阅（避免无限循环）', async () => {
      const { socket, subscribeFrames, deny } = await renderDeniedScenario();

      // 连续三次被拒：首次提示 → 第二次静默重试 → 第三次放弃
      await act(async () => {
        deny();
        await flush();
      });
      expect(FakeNotification.instances).toHaveLength(1);
      await act(async () => {
        deny();
        await flush();
      });
      expect(FakeNotification.instances).toHaveLength(1);
      await act(async () => {
        deny();
        await flush();
      });
      expect(FakeNotification.instances).toHaveLength(2);
      expect(FakeNotification.instances[1]!.options?.body).toContain('刷新页面');

      // 放弃时取消挂起的重试定时器：等待超过重试延迟后不得再出现 subscribe_session
      const before = subscribeFrames().length;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3200));
      });
      expect(subscribeFrames()).toHaveLength(before);
    });
  });
});
