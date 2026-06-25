import { afterEach, describe, expect, test } from 'bun:test';
import { createWorkspaceSocket } from './ws-client';

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
});
