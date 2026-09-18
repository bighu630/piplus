import { useEffect, useState } from 'react';
import hljsLight from 'highlight.js/styles/github.css?url';
import hljsDark from 'highlight.js/styles/github-dark.css?url';
import {
  THEME_STORAGE_KEY,
  applyThemeClass,
  prefersDarkScheme,
  readThemePreference,
  resolveTheme,
  type ResolvedTheme,
  type ThemePreference,
} from './theme';
import { usePersistentState } from './use-persistent-state';

/**
 * 主题偏好 + 生效主题：
 * - 持久化用户偏好（偏好本身，非解析值）；
 * - 仅 system 模式监听系统主题变化；
 * - 把生效主题写到 documentElement（接管 FOUC 脚本）并跟随切换 highlight.js 样式；
 * - 桌面端同步主进程 nativeTheme.themeSource。
 */
export function useAppTheme(): {
  theme: ThemePreference;
  setTheme: (theme: ThemePreference) => void;
  resolvedTheme: ResolvedTheme;
} {
  const [theme, setTheme] = usePersistentState<ThemePreference>(THEME_STORAGE_KEY, readThemePreference);
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDarkScheme());

  // 仅 system 模式监听系统主题变化
  useEffect(() => {
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const resolvedTheme = resolveTheme(theme, systemDark);

  // dark class 应用到 documentElement（React 挂载后接管 FOUC 脚本设置）
  useEffect(() => {
    applyThemeClass(resolvedTheme);
  }, [resolvedTheme]);

  // highlight.js 样式跟随生效主题
  useEffect(() => {
    const hljsLinkId = 'hljs-theme';
    const existing = document.getElementById(hljsLinkId);
    if (existing) existing.remove();
    const link = document.createElement('link');
    link.id = hljsLinkId;
    link.rel = 'stylesheet';
    link.href = resolvedTheme === 'dark' ? hljsDark : hljsLight;
    document.head.appendChild(link);
  }, [resolvedTheme]);

  // 桌面端：偏好变化时同步主进程 nativeTheme.themeSource
  useEffect(() => {
    window.piplusConfig?.theme?.setPreference?.(theme);
  }, [theme]);

  return { theme, setTheme, resolvedTheme };
}
