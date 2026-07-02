/**
 * System notification utilities using the browser Notification API.
 * Works in Electron renderer, Web (HTTPS/localhost), and Docker (HTTPS/localhost).
 */

export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
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
  if (!isNotificationSupported()) return false;
  if (Notification.permission !== 'granted') return false;
  try {
    const n = new Notification(title, options);
    return true;
  } catch {
    return false;
  }
}
