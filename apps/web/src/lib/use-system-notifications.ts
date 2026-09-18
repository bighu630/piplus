import { useCallback, useEffect, useState } from 'react';
import {
  getNotificationPermission,
  requestNotificationPermission,
  systemNotificationsEnabled as readSystemNotificationsEnabled,
  SYSTEM_NOTIFICATIONS_STORAGE_KEY,
} from './notification';
import { usePersistentState } from './use-persistent-state';

/**
 * 系统通知开关：
 * - 开关状态持久化到 SYSTEM_NOTIFICATIONS_STORAGE_KEY；
 * - 挂载时用真实浏览器权限校正持久化状态（仅首帧）；
 * - 开启时向浏览器申请权限，失败则回落并给出状态文案。
 */
export function useSystemNotifications(): {
  enabled: boolean;
  toggle: (enabled: boolean) => Promise<void>;
  permissionStatus: string | null;
} {
  const [enabled, setEnabled] = usePersistentState<boolean>(
    SYSTEM_NOTIFICATIONS_STORAGE_KEY,
    readSystemNotificationsEnabled,
  );
  const [permissionStatus, setPermissionStatus] = useState<string | null>(null);

  // Reconcile persisted toggle state with actual browser permission on mount.
  // If notifications were previously enabled but permission is no longer granted,
  // turn the toggle off and show an inline status message.
  useEffect(() => {
    const permission = getNotificationPermission();
    if (enabled && permission !== 'granted') {
      setEnabled(false);
      if (permission === 'unsupported') {
        setPermissionStatus('unsupported');
      } else {
        // 'denied' or 'default' — either way, notifications won't fire
        setPermissionStatus(permission);
      }
    }
    // Intentionally run only on mount: enabled is the initial value
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = useCallback(async (next: boolean) => {
    if (next) {
      const permission = await requestNotificationPermission();
      if (permission === 'granted') {
        setEnabled(true);
        setPermissionStatus(null);
      } else if (permission === 'denied') {
        setPermissionStatus('denied');
        setEnabled(false);
      } else if (permission === 'default') {
        setPermissionStatus('default');
        setEnabled(false);
      } else {
        setPermissionStatus('unsupported');
        setEnabled(false);
      }
    } else {
      setEnabled(false);
      setPermissionStatus(null);
    }
  }, [setEnabled]);

  return { enabled, toggle, permissionStatus };
}
