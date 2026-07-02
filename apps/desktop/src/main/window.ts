import { app, BrowserWindow } from 'electron';
import { getPreloadPath } from './resolve-paths.js';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';

function logEvent(level: string, msg: string, logsDir?: string) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [desktop/window] [${level}] ${msg}`;
  if (level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
  if (logsDir) {
    appendFile(join(logsDir, 'desktop.log'), line + '\n').catch(() => {
      // best-effort logging
    });
  }
}

export async function createMainWindow(apiBaseUrl: string, logsDir?: string) {
  const devToolsEnabled = process.env.PIPLUS_ENABLE_DEVTOOLS === '1' || !app.isPackaged;

  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: devToolsEnabled,
      preload: getPreloadPath(),
    },
  });

  // ── Load & crash diagnostics ────────────────────────────
  mainWindow.webContents.on('did-finish-load', () => {
    logEvent('info', 'page load finished', logsDir);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logEvent('error', `page load failed: code=${errorCode} desc="${errorDescription}" url=${validatedURL}`, logsDir);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    logEvent('error', `render process gone: reason=${details.reason} exitCode=${details.exitCode}`, logsDir);
  });

  mainWindow.on('unresponsive', () => {
    logEvent('error', `main window unresponsive`, logsDir);
  });

  mainWindow.on('responsive', () => {
    logEvent('info', `main window responsive again`, logsDir);
  });

  // Console messages only captured when devTools are enabled (verbose in prod)
  if (devToolsEnabled) {
    mainWindow.webContents.on('console-message', (_event, level, message, _line, sourceId) => {
      const levels = ['verbose', 'info', 'warning', 'error'];
      const levelName = levels[level] ?? 'debug';
      logEvent(levelName, `[renderer] ${message} (source: ${sourceId})`, logsDir);
    });
  }

  // ── DevTools shortcut (always available in development; packaged only if enabled) ──
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    // F12
    if (input.type === 'keyDown' && input.key === 'F12') {
      if (devToolsEnabled) {
        mainWindow.webContents.toggleDevTools();
      }
      return;
    }
    // Ctrl+Shift+I or Cmd+Shift+I
    if (
      input.type === 'keyDown' &&
      input.key === 'I' &&
      (input.control || input.meta) &&
      input.shift
    ) {
      if (devToolsEnabled) {
        mainWindow.webContents.toggleDevTools();
      }
      return;
    }
  });

  const devUrl = process.env.PIPLUS_WEB_DEV_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
    return mainWindow;
  }

  await mainWindow.loadURL(apiBaseUrl);
  return mainWindow;
}
