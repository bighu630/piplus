/**
 * App UI 偏好的 localStorage 持久化契约（纯函数，无 React / react-query 依赖）。
 *
 * 这些 parse 决定「历史 localStorage 值如何映射回状态」，直接关系到用户已有偏好，
 * 因此与 useAppShell 分开放在这里，便于单独测试，也避免测试间接 import hooks.ts。
 */

export const SIDEBAR_WIDTH_MIN = 240;
export const SIDEBAR_WIDTH_MAX = 520;
export const SIDEBAR_WIDTH_DEFAULT = 256;

/** 'pi-sidebar-width'：与旧手写逻辑一致 —— 空/非数字回落默认值，越界 clamp。 */
export function clampSidebarWidth(raw: string): number {
  const parsed = raw ? Number(raw) : SIDEBAR_WIDTH_DEFAULT;
  return Number.isFinite(parsed) ? Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, parsed)) : SIDEBAR_WIDTH_DEFAULT;
}

/** 'pi-show-completed'：仅显式 'false' 视为关闭（历史默认开启）。 */
export function parseShowCompleted(raw: string): boolean {
  return raw !== 'false';
}

/** 'pi-hidden-completed-roles'：JSON 字符串数组，损坏时回落空数组。 */
export function parseHiddenCompletedRoles(raw: string): string[] {
  try {
    return JSON.parse(raw) as string[];
  } catch {
    return [];
  }
}

/** 从旧 key 'pi-show-worker' 迁移：曾经隐藏 worker → 初始隐藏 worker 角色。 */
export function initialHiddenCompletedRoles(): string[] {
  try {
    const showWorker = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage.getItem('pi-show-worker')
      : null;
    if (showWorker === 'false') return ['worker'];
  } catch {}
  return [];
}
