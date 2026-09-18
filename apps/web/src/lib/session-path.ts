/** 工作区根路径：URL 与会话定位的单一来源。 */
export const WORKSPACE_ROOT_PATH = '/workspace';

/** 会话 id → 浏览器路径（无会话时回落工作区根）。 */
export function getSessionPath(sessionId: string | null): string {
  return sessionId ? `${WORKSPACE_ROOT_PATH}/session/${sessionId}` : WORKSPACE_ROOT_PATH;
}

/** 浏览器路径 → 会话 id（非会话路径返回 null）。 */
export function getSessionIdFromPath(pathname: string): string | null {
  const match = pathname.match(/^\/workspace\/session\/([^/]+)$/);
  return match?.[1] ?? null;
}
