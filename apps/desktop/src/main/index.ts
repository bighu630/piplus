import { app } from 'electron';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { startApiProcess, stopApiProcess } from './api-process.js';
import { waitForHealth } from './health.js';
import { ensureAppPaths } from './paths.js';
import { getFreePort } from './port.js';
import { createMainWindow } from './window.js';
import { getWebProdDir } from './resolve-paths.js';

let apiProcess: ChildProcessWithoutNullStreams | null = null;
let quitting = false;

async function bootstrap() {
  const paths = await ensureAppPaths();
  const port = await getFreePort('127.0.0.1');

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
  const wsBaseUrl = `ws://127.0.0.1:${port}`;

  await waitForHealth(`${apiBaseUrl}/health`);
  await createMainWindow(apiBaseUrl, paths.logsDir);
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
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  quitting = true;
  stopApiProcess(apiProcess);
});
