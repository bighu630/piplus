import { upgradeWebSocket } from 'hono/bun';
import type { Hono } from 'hono';
import type { Context } from 'hono';
import type { WSEvents } from 'hono/ws';
import { createEvent, parseClientMessage } from './protocol';
import { registerSocket } from './session';
import { verifyToken, isAuthEnabled } from '../auth/token';
import { getServerConfig } from '../server-config';
import { WS_EVENT_UNAUTHENTICATED } from '@piplus/shared/ws';
import { TerminalManager } from '../lib/terminal-manager';
import { createDb } from '@piplus/db/client';
import { projects, sessions } from '@piplus/db/schema';
import { eq, and } from 'drizzle-orm';
import { getDbPath } from '../db-context';

const socketHub = registerSocket({
  // 订阅归属校验：auth 关闭时放行（保持现状）；auth 开启时要求连接已认证，
  // 且 sessions.createdBy 与该连接身份一致。bun:sqlite 为同步驱动，回调可保持同步。
  authorizeSubscribe(ws, sessionId) {
    if (!isAuthEnabled()) return true;
    const userId = (ws as any).__userId;
    if (!userId) return false; // 未认证/无身份的连接一律拒绝
    try {
      const db = createDb(`file:${getDbPath()}`);
      const row = db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.createdBy, userId)))
        .limit(1)
        .get();
      return row !== undefined;
    } catch (err) {
      console.error('[ws] subscribe authorization failed:', err);
      return false;
    }
  },
});

const UNAUTHENTICATED_CLOSE_CODE = 4401;

/** 认证超时（毫秒）：默认 10 秒，可用 PIPLUS_WS_AUTH_TIMEOUT_MS 覆盖（测试用）。 */
function authTimeoutMs(): number {
  const raw = process.env.PIPLUS_WS_AUTH_TIMEOUT_MS;
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
}

/** 每个连接的认证状态：仅在 isAuthEnabled() 时存在。 */
type ConnectionAuth = { authenticated: boolean; timer: ReturnType<typeof setTimeout> | null };
const connectionAuth = new WeakMap<object, ConnectionAuth>();

function rejectUnauthenticated(ws: { send(data: string): void; close(code?: number, reason?: string): void }) {
  try {
    ws.send(JSON.stringify(createEvent(WS_EVENT_UNAUTHENTICATED, { reason: 'authentication required' })));
  } catch {
    // socket 可能已关闭，忽略发送失败
  }
  try {
    ws.close(UNAUTHENTICATED_CLOSE_CODE, 'unauthenticated');
  } catch {
    // ignore
  }
}

// Track which terminal sessions belong to each WebSocket connection
// so we can clean up per-connection on disconnect
const connectionTerminals = new WeakMap<object, Set<string>>();

const terminalManager = new TerminalManager(
  (sessionId, data) => {
    // Broadcast terminal_output to all connected sockets
    socketHub.broadcast({
      kind: 'terminal',
      type: 'terminal_output',
      payload: { sessionId, data },
    });
  },
  (sessionId, code) => {
    socketHub.broadcast({
      kind: 'terminal',
      type: 'terminal_exit',
      payload: { sessionId, code },
    });
  },
);

/** 处理器内部使用的最小 socket 形状。 */
type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

/**
 * hono 的 bun adapter 每次事件都会新建 WSContext 包装对象，
 * 连接级状态（__userId、认证状态、终端跟踪）必须挂在底层稳定的
 * BunServerWebSocket（ws.raw）上才能跨 onOpen/onMessage/onClose 保持。
 */
function rawSocketOf(ws: unknown): SocketLike {
  const raw = (ws as { raw?: unknown } | null)?.raw;
  return ((raw !== undefined && raw !== null ? raw : ws) ?? ws) as SocketLike;
}

/**
 * 构造 /ws 路由的 WebSocket 事件处理器（导出以便单元测试直接驱动回调，
 * 无需真实网络）。生产路径由 registerWebSocketRoutes 接入 hono。
 */
export function createWebSocketHooks(c: Context): WSEvents {
  async function handleOpen(_evt: unknown, ws: SocketLike) {
    const rawWs = rawSocketOf(ws);
    const rawHeaders = c.req.raw.headers;
    const header = rawHeaders.get('Authorization') ?? '';
    let token = header.replace(/^Bearer\s+/i, '').trim();
    // 非浏览器客户端兼容：允许 URL query ?token= 携带 token。
    // 注意：含 token 的 URL 绝不能进入任何日志/console 输出。
    if (!token) {
      try {
        token = new URL(c.req.url).searchParams.get('token') ?? '';
      } catch {
        token = '';
      }
    }

    // 身份判定顺序与 middleware/auth.ts 的 requireAuth 一致：
    // 1. 有效 v2 token → 'local-user'
    // 2. 非 production 且带 x-user-id 头 → 该头值（开发/测试回退；production 下拒绝）
    // 3. auth 关闭（本地 Electron 场景）→ 默认 'local-user'
    const authEnabled = isAuthEnabled();
    let userId: string | undefined;
    if (verifyToken(token)) {
      userId = 'local-user';
    } else if (!authEnabled) {
      userId = c.req.header('x-user-id') ?? 'local-user';
    } else {
      const devUserId = c.req.header('x-user-id');
      if (devUserId && getServerConfig().nodeEnv !== 'production') {
        userId = devUserId;
      }
    }
    if (userId) {
      (rawWs as { __userId?: string }).__userId = userId;
    }

    if (authEnabled && !verifyToken(token)) {
      // 未认证连接先 attach 并启动认证超时；仅 hello 帧可完成认证。
      const auth: ConnectionAuth = { authenticated: false, timer: null };
      connectionAuth.set(rawWs, auth);
      auth.timer = setTimeout(() => {
        if (!connectionAuth.get(rawWs)?.authenticated) {
          rejectUnauthenticated(ws);
        }
      }, authTimeoutMs());
    }

    socketHub.attach(rawWs);
    ws.send(JSON.stringify(createEvent('connection.opened', { status: 'ok' })));
  }

  async function handleMessage(evt: { data: unknown }, ws: SocketLike) {
    const rawWs = rawSocketOf(ws);
    const raw = typeof evt.data === 'string' ? evt.data : '';
    const parsed = parseClientMessage(raw);
    if (!parsed) return;

    // 认证门禁：未认证状态下忽略除 hello 外的所有消息。
    const auth = connectionAuth.get(rawWs);
    if (auth && !auth.authenticated) {
      if (parsed.type !== 'hello') return;
      const helloToken = typeof parsed.payload.token === 'string' ? parsed.payload.token : '';
      if (!verifyToken(helloToken)) {
        if (auth.timer !== null) clearTimeout(auth.timer);
        rejectUnauthenticated(ws);
        return;
      }
      // 首帧 auth 握手通过：标记已认证、取消超时，后续消息正常处理。
      auth.authenticated = true;
      if (auth.timer !== null) {
        clearTimeout(auth.timer);
        auth.timer = null;
      }
      (rawWs as { __userId?: string }).__userId = 'local-user';
    }

    socketHub.handleClientMessage(rawWs, parsed);

      if (parsed.type === 'hello') {
        ws.send(JSON.stringify(createEvent('connection.hello', { user_agent: parsed.payload.user_agent ?? null })));
      }

      if (parsed.type === 'set_context') {
        ws.send(JSON.stringify(createEvent('context.updated', parsed.payload)));
      }

      if (parsed.type === 'ping') {
        ws.send(JSON.stringify(createEvent('connection.pong', { timestamp: parsed.payload.timestamp })));
      }

      // Terminal message handling
      if (parsed.type === 'terminal_start') {
        const userId = (rawWs as { __userId?: string }).__userId;
        // 去掉 'local-user' 兑底：auth 开启且连接未认证/无身份时拒绝 terminal_start。
        // 选择静默忽略，避免向未认证连接回送可被用于探测的错误信息。
        if (isAuthEnabled() && !userId) {
          // rejected: ignore silently
        } else {
          try {
            const { sessionId, cols, rows } = (parsed as any).payload as { sessionId: string; cols: number; rows: number };
            const db = createDb(`file:${getDbPath()}`);
            // 归属校验改查 sessions.createdBy（此前误查 projects.createdBy）；
            // auth 关闭时放行（本地场景 createdBy 可能为空），不做归属过滤。
            const ownershipFilter = isAuthEnabled() && userId ? eq(sessions.createdBy, userId) : undefined;
            const [row] = await db
              .select({ projectPath: projects.projectPath })
              .from(sessions)
              .innerJoin(projects, eq(sessions.projectId, projects.id))
              .where(
                ownershipFilter
                  ? and(eq(sessions.id, sessionId), ownershipFilter)
                  : eq(sessions.id, sessionId),
              )
              .limit(1);
            if (row) {
              terminalManager.start(sessionId, row.projectPath, cols, rows);
              // Track this terminal session for this connection
              const tracked = connectionTerminals.get(rawWs) ?? new Set<string>();
              connectionTerminals.set(rawWs, tracked);
              tracked.add(sessionId);
            }
          } catch (err) {
            console.error('[Terminal] Failed to start terminal:', err);
          }
        }
      }

      if (parsed.type === 'terminal_input') {
        const { sessionId, data } = (parsed as any).payload as { sessionId: string; data: string };
        terminalManager.write(sessionId, data);
      }

      if (parsed.type === 'terminal_resize') {
        const { sessionId, cols, rows } = (parsed as any).payload as { sessionId: string; cols: number; rows: number };
        terminalManager.resize(sessionId, cols, rows);
      }

      if (parsed.type === 'terminal_stop') {
        const { sessionId } = (parsed as any).payload as { sessionId: string };
        terminalManager.stop(sessionId);
        // Remove from per-connection tracking
        const trackedSessions = connectionTerminals.get(rawWs);
        if (trackedSessions) {
          trackedSessions.delete(sessionId);
        }
      }
  }

  function handleClose(_evt: unknown, ws: SocketLike) {
      const rawWs = rawSocketOf(ws);
      const auth = connectionAuth.get(rawWs);
      if (auth?.timer !== null && auth?.timer !== undefined) {
        clearTimeout(auth.timer);
      }
      connectionAuth.delete(rawWs);
      socketHub.detach(rawWs);
      // Clean up only this connection's terminal sessions
      const terminalSessionIds = connectionTerminals.get(rawWs);
      if (terminalSessionIds) {
        for (const sessionId of terminalSessionIds) {
          terminalManager.stop(sessionId);
        }
        connectionTerminals.delete(rawWs);
      }
    }

  return {
    onOpen: (evt, ws) => handleOpen(evt, ws as unknown as SocketLike),
    onMessage: (evt, ws) => handleMessage(evt as { data: unknown }, ws as unknown as SocketLike),
    onClose: (evt, ws) => handleClose(evt, ws as unknown as SocketLike),
  };
}

export function registerWebSocketRoutes(app: Hono) {
  /**
   * @swagger
   * /ws:
   *   get:
   *     summary: 建立 WebSocket 实时连接
   *     tags: [WebSocket]
   *     description: |
   *       连接建立后会立即下发 connection.opened 事件。
   *       客户端可发送 hello、set_context、ping 三类消息。
   *       服务端会下发 event 与 chat_stream 两类消息。
   */
  app.get('/ws', upgradeWebSocket((c) => createWebSocketHooks(c)));
}

export { socketHub, terminalManager };
