import { app, ipcMain, nativeTheme } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const THEME_PREFS = ['light', 'dark', 'system'] as const;
type ThemePreference = (typeof THEME_PREFS)[number];

const DEFAULT_PREFERENCE: ThemePreference = 'system';

function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFS as readonly string[]).includes(value);
}

function getThemeFilePath(): string {
  return join(app.getPath('userData'), 'theme.json');
}

async function readStoredPreference(): Promise<ThemePreference> {
  try {
    const raw = await readFile(getThemeFilePath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && isThemePreference((parsed as { preference?: unknown }).preference)) {
      return (parsed as { preference: ThemePreference }).preference;
    }
  } catch {
    // file missing or malformed → default
  }
  return DEFAULT_PREFERENCE;
}

function persistPreference(preference: ThemePreference): void {
  writeFile(getThemeFilePath(), JSON.stringify({ preference }), 'utf-8').catch(() => {
    // best-effort persistence
  });
}

export async function initTheme(): Promise<void> {
  const preference = await readStoredPreference();
  nativeTheme.themeSource = preference;

  ipcMain.on('theme:set-preference', (_event, preference: unknown) => {
    if (!isThemePreference(preference)) return;
    nativeTheme.themeSource = preference;
    persistPreference(preference);
  });
}
