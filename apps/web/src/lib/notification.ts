/**
 * System notification utilities using the browser Notification API.
 * Works in Electron renderer, Web (HTTPS/localhost), and Docker (HTTPS/localhost).
 */

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/** 系统通知总开关的 localStorage key（App 设置面板与各通知发送点共用同一 key）。 */
export const SYSTEM_NOTIFICATIONS_STORAGE_KEY = 'pi-system-notifications';

/** 读取系统通知总开关（每次现读，保证设置面板切换后立即生效）。 */
export function systemNotificationsEnabled(): boolean {
  try {
    // 用 window.localStorage 而非裸 localStorage：与 auth-session 的 safeStorage 保持一致，
    // 不依赖具体运行时是否把 localStorage 挂到 globalThis（测试/非浏览器环境可能没有）。
    if (typeof window === 'undefined' || !window.localStorage) return false;
    return window.localStorage.getItem(SYSTEM_NOTIFICATIONS_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isNotificationSupported()) return 'unsupported';
  return Notification.permission;
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isNotificationSupported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  return permission;
}

/**
 * Send a system notification.
 * @returns true if the notification was sent (permission was granted), false otherwise.
 */
export function sendSystemNotification(title: string, options?: NotificationOptions): boolean {
  return createSystemNotification(title, options) !== null;
}

/**
 * Create a system notification and return the instance so callers can bind
 * interactions (onclick → focus window + jump to the session).
 * @returns the Notification, or null when unsupported / permission not granted / construction failed.
 */
export function createSystemNotification(title: string, options?: NotificationOptions): Notification | null {
  if (!isNotificationSupported()) return null;
  if (Notification.permission !== 'granted') return null;
  try {
    return new Notification(title, options);
  } catch {
    return null;
  }
}
