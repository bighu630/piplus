import { describe, expect, test, mock, afterEach } from 'bun:test';
import { createWorkspaceSocket } from '../ws-client';

describe('createWorkspaceSocket', () => {
  afterEach(() => {
    (globalThis as any).WebSocket = undefined;
  });

  test('returns a socket object with hello, setContext, ping, close', () => {
    const sent: string[] = [];
    const mockWs = {
      addEventListener: mock(() => {}),
      send: mock((data: string) => sent.push(data)),
      close: mock(() => {}),
    };
    (globalThis as any).WebSocket = mock(() => mockWs);

    const ws = createWorkspaceSocket(() => {});

    ws.hello();
    ws.setContext({ project_id: 'p1', session_id: 's1', current_tab: 'chat' });
    ws.ping();
    ws.close();

    expect(sent.length).toBe(3);

    const hello = JSON.parse(sent[0]!);
    expect(hello.type).toBe('hello');
    expect(hello.kind).toBe('client');
    expect(hello.payload.user_agent).toBeTruthy();

    const ctx = JSON.parse(sent[1]!);
    expect(ctx.type).toBe('set_context');
    expect(ctx.payload.project_id).toBe('p1');
    expect(ctx.payload.session_id).toBe('s1');
    expect(ctx.payload.current_tab).toBe('chat');

    const ping = JSON.parse(sent[2]!);
    expect(ping.type).toBe('ping');
    expect(ping.payload.timestamp).toBeTruthy();

    expect(mockWs.close).toHaveBeenCalled();
  });

  test('registers message handler on the socket', () => {
    const listeners: Record<string, Function> = {};
    const mockWs = {
      addEventListener: mock((event: string, fn: Function) => { listeners[event] = fn; }),
      send: mock(() => {}),
      close: mock(() => {}),
    };
    (globalThis as any).WebSocket = mock(() => mockWs);
    const messages: MessageEvent[] = [];
    createWorkspaceSocket((ev) => messages.push(ev));

    expect(listeners.message).toBeFunction();
    const fakeEvent = { data: JSON.stringify({ kind: 'event', type: 'test' }) };
    listeners.message!(fakeEvent);
    expect(messages.length).toBe(1);
  });
});
