import { afterEach, describe, expect, test } from 'bun:test';
import { createWorkspaceSocket, nextReconnectDelay } from './ws-client';

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

describe('nextReconnectDelay', () => {
  test('exponential backoff with cap', () => {
    expect(nextReconnectDelay(0)).toBe(2000);
    expect(nextReconnectDelay(1)).toBe(4000);
    expect(nextReconnectDelay(2)).toBe(8000);
    expect(nextReconnectDelay(3)).toBe(16000);
    expect(nextReconnectDelay(4)).toBe(30000); // 32000 → capped
    expect(nextReconnectDelay(10)).toBe(30000);
  });
});

describe('createWorkspaceSocket', () => {
  const originalWindow = globalThis.window;
  const originalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    FakeWebSocket.instances = [];
    globalThis.window = originalWindow;
    globalThis.WebSocket = originalWebSocket;
  });

  test('does not construct a websocket when closed before the deferred connect runs', async () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
        host: 'localhost:3000',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const socket = createWorkspaceSocket({
      onMessage() {},
    });

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  test('ignores protocol messages before the websocket is constructed', () => {
    globalThis.window = {
      location: {
        protocol: 'http:',
        host: 'localhost:3000',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const socket = createWorkspaceSocket({
      onMessage() {},
    });

    expect(() => {
      socket.setContext({ session_id: 'session-1', current_tab: 'chat' });
      socket.ping();
    }).not.toThrow();

    socket.close();
  });

  test('connects and sends protocol messages after open', async () => {
    globalThis.window = {
      location: {
        protocol: 'https:',
        host: 'demo.example.com',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const socket = createWorkspaceSocket({
      onMessage() {},
    });

    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe('wss://demo.example.com/ws');

    FakeWebSocket.instances[0]?.open();
    socket.hello();

    expect(FakeWebSocket.instances[0]?.sent).toHaveLength(1);
    expect(JSON.parse(FakeWebSocket.instances[0]?.sent[0] ?? '{}')).toMatchObject({
      kind: 'client',
      type: 'hello',
    });
  });

  test('close code 4401 stops reconnection and dispatches the logout event', async () => {
    const dispatched: string[] = [];
    globalThis.window = {
      location: { protocol: 'https:', host: 'demo.example.com' },
      piplusConfig: {},
      dispatchEvent: (event: Event) => {
        dispatched.push(event.type);
        return true;
      },
    } as unknown as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    let closeCount = 0;
    const socket = createWorkspaceSocket({
      onMessage() {},
      onClose() {
        closeCount += 1;
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.dispatch('close', { code: 4401 });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 不重连：没有新的 WebSocket 实例；onClose 只触发一次
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(closeCount).toBe(1);
    expect(dispatched).toContain('piplus:logout');

    socket.close();
  });

  test('normal close still schedules a reconnect', async () => {
    globalThis.window = {
      location: { protocol: 'https:', host: 'demo.example.com' },
      piplusConfig: {},
    } as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const socket = createWorkspaceSocket({ onMessage() {} });

    await new Promise((resolve) => setTimeout(resolve, 5));
    FakeWebSocket.instances[0]?.open();
    FakeWebSocket.instances[0]?.dispatch('close', { code: 1000 });

    // 正常关闭（非 4401）会安排重连，产生第二个实例
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    socket.close();
  });
});
