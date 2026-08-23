import { afterEach, describe, expect, test } from 'bun:test';
import type { Context } from 'hono';
import { createToken } from '../auth/token';
import { DEFAULT_TOKEN_TTL_HOURS } from '../server-config';
import { createWebSocketHooks } from './server';

// NOTE: bun test runs all files in one process; keep async gaps short and
// restore env synchronously in afterEach (same pattern as auth/token.test.ts).

const TEST_PASSWORD = 'test-secret'; // same value other test files use
const FAST_TIMEOUT_MS = '40';

type Listener = (event?: unknown) => void;

/** Mimics the BunServerWebSocket underneath hono's WSContext (stable identity). */
class FakeRawSocket {
  sent: string[] = [];
  closeCodes: number[] = [];
  send(data: string) {
    this.sent.push(data);
  }
  close(code?: number, _reason?: string) {
    this.closeCodes.push(code ?? 0);
  }
}

/** Mimics hono's per-event WSContext wrapper (new object per event, `.raw` stable). */
function wsContextOf(raw: FakeRawSocket): { raw: FakeRawSocket; send: (d: string) => void; close: (c?: number, r?: string) => void } {
  return {
    raw,
    send: (d: string) => raw.send(d),
    close: (c?: number, r?: string) => raw.close(c, r),
  };
}

function createContext(opts: { headers?: Record<string, string>; url?: string } = {}): Context {
  const h = new Headers(opts.headers);
  return {
    req: {
      raw: { headers: h },
      header: (name: string) => h.get(name),
      url: opts.url ?? 'http://127.0.0.1:3001/ws',
    },
  } as unknown as Context;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lastEvent(raw: FakeRawSocket): { kind: string; type: string; payload: Record<string, unknown> } | null {
  const last = raw.sent.at(-1);
  if (!last) return null;
  try {
    return JSON.parse(last);
  } catch {
    return null;
  }
}

describe('ws server auth handshake (H1)', () => {
  const originalPassword = Bun.env.APP_PASSWORD;
  const originalNodeEnv = Bun.env.NODE_ENV;
  const originalTimeout = Bun.env.PIPLUS_WS_AUTH_TIMEOUT_MS;

  afterEach(() => {
    if (originalPassword === undefined) delete Bun.env.APP_PASSWORD;
    else Bun.env.APP_PASSWORD = originalPassword;
    if (originalNodeEnv === undefined) delete Bun.env.NODE_ENV;
    else Bun.env.NODE_ENV = originalNodeEnv;
    if (originalTimeout === undefined) delete Bun.env.PIPLUS_WS_AUTH_TIMEOUT_MS;
    else Bun.env.PIPLUS_WS_AUTH_TIMEOUT_MS = originalTimeout;
  });

  function enableFastAuth() {
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    Bun.env.PIPLUS_WS_AUTH_TIMEOUT_MS = FAST_TIMEOUT_MS;
  }

  test('auth enabled: connection without token is rejected after timeout (unauthenticated + 4401)', async () => {
    enableFastAuth();
    const hooks = createWebSocketHooks(createContext());
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    // 连接先被 attach 并收到 connection.opened，但处于未认证状态
    expect(raw.sent).toHaveLength(1);
    expect(lastEvent(raw)?.type).toBe('connection.opened');

    await sleep(120);
    expect(lastEvent(raw)?.type).toBe('connection.unauthenticated');
    expect(raw.closeCodes).toContain(4401);
  });

  test('auth enabled: forged token is rejected (unauthenticated + 4401)', async () => {
    enableFastAuth();
    const hooks = createWebSocketHooks(
      createContext({ headers: { Authorization: 'Bearer v2.forged.sig' } }),
    );
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await sleep(120);
    expect(lastEvent(raw)?.type).toBe('connection.unauthenticated');
    expect(raw.closeCodes).toContain(4401);
  });

  test('auth enabled: expired but correctly-signed token is rejected', async () => {
    enableFastAuth();
    const ttlMs = DEFAULT_TOKEN_TTL_HOURS * 60 * 60 * 1000;
    const expiredToken = createToken(Date.now() - ttlMs - 60_000);
    const hooks = createWebSocketHooks(
      createContext({ headers: { Authorization: `Bearer ${expiredToken}` } }),
    );
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await sleep(120);
    expect(lastEvent(raw)?.type).toBe('connection.unauthenticated');
    expect(raw.closeCodes).toContain(4401);
  });

  test('auth enabled: valid token via Authorization header authenticates immediately', async () => {
    enableFastAuth();
    Bun.env.APP_PASSWORD = TEST_PASSWORD;
    const token = createToken();
    const hooks = createWebSocketHooks(
      createContext({ headers: { Authorization: `Bearer ${token}` } }),
    );
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await sleep(120); // 超过认证超时窗口也不应被拒
    expect(raw.closeCodes).toHaveLength(0);

    // 认证后消息正常处理
    await hooks.onMessage?.({ data: JSON.stringify({ kind: 'client', type: 'ping', payload: { timestamp: 't' } }) } as never, ws as never);
    expect(lastEvent(raw)?.type).toBe('connection.pong');
  });

  test('auth enabled: valid token via ?token= query authenticates immediately', async () => {
    enableFastAuth();
    const token = createToken();
    const hooks = createWebSocketHooks(
      createContext({ url: `http://127.0.0.1:3001/ws?token=${encodeURIComponent(token)}` }),
    );
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await sleep(120);
    expect(raw.closeCodes).toHaveLength(0);
    await hooks.onMessage?.({ data: JSON.stringify({ kind: 'client', type: 'ping', payload: { timestamp: 't' } }) } as never, ws as never);
    expect(lastEvent(raw)?.type).toBe('connection.pong');
  });

  test('auth enabled: hello frame with valid token completes the handshake', async () => {
    enableFastAuth();
    const token = createToken();
    const hooks = createWebSocketHooks(createContext());
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await hooks.onMessage?.(
      { data: JSON.stringify({ kind: 'client', type: 'hello', payload: { token } }) } as never,
      ws as never,
    );

    // 握手成功：正常回 connection.hello，不关闭连接
    expect(lastEvent(raw)?.type).toBe('connection.hello');
    expect(raw.closeCodes).toHaveLength(0);

    // 认证后的后续消息不再被忽略
    await hooks.onMessage?.({ data: JSON.stringify({ kind: 'client', type: 'ping', payload: { timestamp: 't' } }) } as never, ws as never);
    expect(lastEvent(raw)?.type).toBe('connection.pong');
  });

  test('auth enabled: hello frame with invalid token is rejected with 4401', async () => {
    enableFastAuth();
    const hooks = createWebSocketHooks(createContext());
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await hooks.onMessage?.(
      { data: JSON.stringify({ kind: 'client', type: 'hello', payload: { token: 'v2.bad.sig' } }) } as never,
      ws as never,
    );

    expect(lastEvent(raw)?.type).toBe('connection.unauthenticated');
    expect(raw.closeCodes).toContain(4401);
  });

  test('auth enabled: non-hello messages are ignored while unauthenticated', async () => {
    enableFastAuth();
    const hooks = createWebSocketHooks(createContext());
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await hooks.onMessage?.(
      { data: JSON.stringify({ kind: 'client', type: 'ping', payload: { timestamp: 't' } }) } as never,
      ws as never,
    );

    // 只有初始的 connection.opened，没有 pong，也没有立即关闭（等待认证窗口）
    expect(raw.sent).toHaveLength(1);
    expect(raw.closeCodes).toHaveLength(0);
  });

  test('auth enabled: x-user-id header does NOT authenticate in production', async () => {
    enableFastAuth();
    Bun.env.NODE_ENV = 'production';
    const hooks = createWebSocketHooks(createContext({ headers: { 'x-user-id': 'attacker' } }));
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await sleep(120);
    // 生产环境下伪造 x-user-id 无法通过认证
    expect(lastEvent(raw)?.type).toBe('connection.unauthenticated');
    expect(raw.closeCodes).toContain(4401);
  });

  test('auth disabled: anonymous connection works exactly as before', async () => {
    delete Bun.env.APP_PASSWORD;
    delete Bun.env.PIPLUS_WS_AUTH_TIMEOUT_MS;
    const hooks = createWebSocketHooks(createContext());
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    await hooks.onOpen?.(new Event('open'), ws as never);
    await sleep(80); // 无认证定时器，不应有任何拒绝行为

    expect(raw.closeCodes).toHaveLength(0);
    await hooks.onMessage?.({ data: JSON.stringify({ kind: 'client', type: 'hello', payload: {} }) } as never, ws as never);
    expect(lastEvent(raw)?.type).toBe('connection.hello');
    await hooks.onMessage?.({ data: JSON.stringify({ kind: 'client', type: 'ping', payload: { timestamp: 't' } }) } as never, ws as never);
    expect(lastEvent(raw)?.type).toBe('connection.pong');
  });

  test('auth disabled: x-user-id header is honored outside production', () => {
    delete Bun.env.APP_PASSWORD;
    const hooks = createWebSocketHooks(createContext({ headers: { 'x-user-id': 'dev-user' } }));
    const raw = new FakeRawSocket();
    const ws = wsContextOf(raw);

    return Promise.resolve(hooks.onOpen?.(new Event('open'), ws as never)).then(() => {
      expect((raw as unknown as { __userId?: string }).__userId).toBe('dev-user');
    });
  });
});
