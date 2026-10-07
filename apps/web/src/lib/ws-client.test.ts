import { afterEach, describe, expect, test } from 'bun:test';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_SILENCE_TIMEOUT_MS,
  createWorkspaceSocket,
  nextReconnectDelay,
} from './ws-client';

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

describe('心跳默认参数', () => {
  test('生产默认：心跳周期在 25-30s，静默容忍窗口为 2 个周期', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(25_000);
    expect(HEARTBEAT_INTERVAL_MS).toBeLessThanOrEqual(30_000);
    expect(HEARTBEAT_SILENCE_TIMEOUT_MS).toBe(HEARTBEAT_INTERVAL_MS * 2);
  });
});

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

  test('心跳：空闲超过 2 个周期未收到任何消息时主动关闭，并触发既有重连', async () => {
    globalThis.window = {
      location: { protocol: 'https:', host: 'demo.example.com' },
      piplusConfig: {},
    } as unknown as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    let closeCount = 0;
    // 注入短周期：production 为 25s/50s，这里 20ms/40ms
    const socket = createWorkspaceSocket({
      onMessage() {},
      onClose() { closeCount += 1; },
      heartbeatIntervalMs: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = FakeWebSocket.instances[0]!;
    first.open();

    // 静默窗口 = 2 * 20ms：一个周期后仍在等（未误判），两个周期后主动关闭；期间应至少发过一次 ping
    await new Promise((resolve) => setTimeout(resolve, 27));
    expect(first.closeCalls).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pingCount = first.sent
      .map((raw) => JSON.parse(raw) as { type?: string })
      .filter((m) => m.type === 'ping').length;
    expect(pingCount).toBeGreaterThanOrEqual(1);
    expect(first.closeCalls).toBeGreaterThanOrEqual(1);
    expect(closeCount).toBeGreaterThanOrEqual(1);

    // 关闭走既有 close → 指数退避重连路径（首次退避 2000ms）
    await new Promise((resolve) => setTimeout(resolve, 2100));
    expect(FakeWebSocket.instances.length).toBeGreaterThanOrEqual(2);

    socket.close();
  });

  test('心跳：收到任何消息（如 connection.pong）会重置静默窗口，不误判断线', async () => {
    globalThis.window = {
      location: { protocol: 'https:', host: 'demo.example.com' },
      piplusConfig: {},
    } as unknown as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const socket = createWorkspaceSocket({
      onMessage() {},
      heartbeatIntervalMs: 20,
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = FakeWebSocket.instances[0]!;
    first.open();

    // 每 15ms 来一条消息（< 40ms 静默窗口），心跳不得关闭连接
    const keepAlive = setInterval(() => {
      first.dispatch('message', { data: JSON.stringify({ kind: 'event', type: 'connection.pong', payload: {} }) } as MessageEvent);
    }, 15);
    await new Promise((resolve) => setTimeout(resolve, 160));
    clearInterval(keepAlive);
    expect(first.closeCalls).toBe(0);

    // 停止消息后仍会因静默超时关闭（证明判定逻辑没有失效）
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(first.closeCalls).toBeGreaterThanOrEqual(1);

    socket.close();
  });

  test('心跳：close() 清理定时器，不再发送 ping', async () => {
    globalThis.window = {
      location: { protocol: 'https:', host: 'demo.example.com' },
      piplusConfig: {},
    } as unknown as Window & typeof globalThis;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;

    const socket = createWorkspaceSocket({ onMessage() {}, heartbeatIntervalMs: 20 });

    await new Promise((resolve) => setTimeout(resolve, 5));
    const first = FakeWebSocket.instances[0]!;
    first.open();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const sentBeforeClose = first.sent.length;

    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(first.sent.length).toBe(sentBeforeClose);
    expect(first.closeCalls).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
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
