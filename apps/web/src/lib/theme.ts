export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'pi-workspace-theme';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'system';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function readThemePreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemePreference(saved)) return saved;
  } catch {
    // localStorage unavailable (private mode / disabled)
  }
  return DEFAULT_THEME_PREFERENCE;
}

export function prefersDarkScheme(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia(DARK_MEDIA_QUERY).matches;
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

export function applyThemeClass(theme: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark');
}
