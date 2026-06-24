import { app, BrowserWindow } from 'electron';
import { getPreloadPath } from './resolve-paths.js';

export async function createMainWindow(apiBaseUrl: string) {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
      preload: getPreloadPath(),
    },
  });

  const devUrl = process.env.PIPLUS_WEB_DEV_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
    return mainWindow;
  }

  await mainWindow.loadURL(apiBaseUrl);
  return mainWindow;
}
