import { app, BrowserWindow } from 'electron';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import { startApiProcess, stopApiProcess } from './api-process.js';
import { waitForHealth } from './health.js';
import { ensureAppPaths } from './paths.js';
import { getFreePort, getPreferredPort } from './port.js';
import { createMainWindow } from './window.js';
import { getWebProdDir, desktopDistRoot } from './resolve-paths.js';
import { createAppTray } from './tray.js';

let apiProcess: ChildProcessWithoutNullStreams | null = null;
let quitting = false;
let hasTray = false;
let mainWindow: BrowserWindow | null = null;

function getTrayIconPath(): string {
  if (app.isPackaged) {
    return resolve(process.resourcesPath, 'assets', 'tray-icon.png');
  }
  return resolve(desktopDistRoot, '../assets', 'tray-icon.png');
}

async function bootstrap() {
  const paths = await ensureAppPaths();

  // In packaged mode use a preferred (stable) port so localStorage
  // origin is consistent across restarts; fall back to random if taken.
  // In dev mode continue using random port to avoid conflicts with
  // other local instances.
  const { port } = app.isPackaged
    ? await getPreferredPort('127.0.0.1')
    : { port: await getFreePort('127.0.0.1') };

  apiProcess = startApiProcess({
    port,
    paths,
    appPassword: process.env.APP_PASSWORD,
    webDistDir: app.isPackaged ? getWebProdDir() : undefined,
  });

  apiProcess.once('exit', (code, signal) => {
    console.log('[desktop] api process exited', { code, signal });
    if (!quitting) {
      app.quit();
    }
  });

  const apiBaseUrl = `http://127.0.0.1:${port}`;

  await waitForHealth(`${apiBaseUrl}/health`);
  mainWindow = await createMainWindow(apiBaseUrl, paths.logsDir);

  // ── System tray ──────────────────────────────────────────
  const tray = createAppTray({
    mainWindow,
    iconPath: getTrayIconPath(),
    onQuit: () => {
      quitting = true;
      app.quit();
    },
  });

  // ── Close-to-tray ────────────────────────────────────────
  // Only intercept window close when the tray is available so
  // that users on desktop environments without tray support
  // can still quit normally by closing the window.
  hasTray = tray !== null;
  if (hasTray) {
    mainWindow.on('close', (event) => {
      if (!quitting) {
        event.preventDefault();
        mainWindow?.hide();
      }
    });
  }
}

app.whenReady().then(async () => {
  try {
    await bootstrap();
  } catch (error) {
    console.error('[desktop] bootstrap failed', error);
    stopApiProcess(apiProcess);
    app.quit();
  }
});

app.on('window-all-closed', () => {
  // If the tray is active, only quit when the user explicitly
  // chose "退出" from the tray menu.  Close-to-tray intercepts
  // normal window closure, so reaching here means a real quit.
  if (hasTray) {
    if (quitting) {
      app.quit();
    }
    return;
  }
  // No tray available: restore original behavior — quit
  // immediately on non-macOS when all windows close.
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // Restore the window when the app is activated (e.g. macOS dock
  // click, tray click).  On Linux/Windows this also covers cases
  // where the user re-launches while the instance is already running.
  if (mainWindow) {
    mainWindow.show();
    mainWindow.focus();
  }
});

app.on('before-quit', () => {
  quitting = true;
  stopApiProcess(apiProcess);
});
