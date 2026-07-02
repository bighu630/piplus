import { Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import { existsSync } from 'node:fs';

export interface TrayOptions {
  mainWindow: BrowserWindow;
  /** Absolute path to the tray icon PNG file. */
  iconPath: string;
  /** Called when user selects "退出" from the tray context menu. */
  onQuit: () => void;
}

/**
 * Create a system-tray icon with a right-click context menu.
 *
 * - **显示** → restores and focuses the main window.
 * - **退出** → invokes `onQuit` to perform a real application exit.
 *
 * Single left-click on the tray icon also shows the window.
 *
 * Returns the `Tray` instance on success, or `null` if tray creation
 * failed (missing icon file, unsupported desktop environment, etc.).
 * Failures are logged but never crash the application.
 */
export function createAppTray(options: TrayOptions): Tray | null {
  const { mainWindow, iconPath, onQuit } = options;

  // ── Validate icon file ────────────────────────────────────
  if (!existsSync(iconPath)) {
    console.warn(`[desktop/tray] Tray icon not found at ${iconPath}, skipping tray`);
    return null;
  }

  try {
    const icon = nativeImage.createFromPath(iconPath);
    const tray = new Tray(icon);

    tray.setToolTip('PiPlus');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示',
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          onQuit();
        },
      },
    ]);

    tray.setContextMenu(contextMenu);

    // Left-click also restores the window for convenience.
    tray.on('click', () => {
      mainWindow.show();
      mainWindow.focus();
    });

    console.log('[desktop/tray] Tray created');
    return tray;
  } catch (error) {
    console.warn('[desktop/tray] Failed to create tray:', error);
    return null;
  }
}
