/**
 * In-memory request context for cross-session wait coordination.
 *
 * When a parent spawns a child (or sends a follow-up message) with wait=true,
 * the framework binds a unique requestId to the target child session.
 * Later, writeback_to_parent reads this requestId so the parent can
 * match the response to the exact request.
 *
 * We use a singleton map keyed by sessionId.  Because the runtime already
 * enforces "one active run per session", there is never more than one
 * outstanding request for a given session at a time.
 */

type RequestContextEntry = {
  requestId: string;
  startedAt: number;
};

const ctx = new Map<string, RequestContextEntry>();

export function setRequestContext(sessionId: string, requestId: string) {
  ctx.set(sessionId, { requestId, startedAt: Date.now() });
}

export function getRequestContext(sessionId: string): RequestContextEntry | undefined {
  return ctx.get(sessionId);
}

export function clearRequestContext(sessionId: string) {
  ctx.delete(sessionId);
}
