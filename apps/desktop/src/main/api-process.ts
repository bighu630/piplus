import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createWriteStream, type WriteStream } from 'node:fs';
import { resolve } from 'node:path';
import type { AppPaths } from './paths.js';
import { getApiCwd, getApiEntryPath, repoRoot, resolveBunExecutable } from './resolve-paths.js';

export type ApiProcessOptions = {
  port: number;
  paths: AppPaths;
  appPassword?: string;
  webDistDir?: string;
};

export function startApiProcess(options: ApiProcessOptions): ChildProcessWithoutNullStreams {
  const bunExecutable = resolveBunExecutable();
  console.log(`[desktop/api] Using bun executable: ${bunExecutable}`);
  const webDistDir = options.webDistDir ?? resolve(repoRoot, 'apps/web/dist');
  const apiLogPath = resolve(options.paths.logsDir, 'api.log');
  const logStream: WriteStream = createWriteStream(apiLogPath, { flags: 'a' });
  let logStreamHealthy = true;
  logStream.on('error', (err) => {
    logStreamHealthy = false;
    console.error(`[desktop/api] log write error:`, err);
  });
  logStream.on('close', () => {
    logStreamHealthy = false;
  });

  const child = spawn(bunExecutable, [getApiEntryPath()], {
    cwd: getApiCwd(),
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      API_HOST: '127.0.0.1',
      API_PORT: String(options.port),
      PIPLUS_DATA_DIR: options.paths.dataDir,
      DATABASE_URL: `file:${options.paths.databasePath}`,
      PROJECTS_ROOT: options.paths.projectsDir,
      PIPLUS_WEB_DIST: webDistDir,
      PIPLUS_SERVE_WEB: '1',
      PIPLUS_FORCE_ROLE_PROMPTS: 'true',
      ...(options.appPassword ? { APP_PASSWORD: options.appPassword } : {}),
    },
    stdio: 'pipe',
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[desktop/api] ${chunk}`);
    if (logStreamHealthy) logStream.write(chunk);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[desktop/api] ${chunk}`);
    if (logStreamHealthy) logStream.write(chunk);
  });

  child.once('exit', (code, signal) => {
    const timestamp = new Date().toISOString();
    const exitMsg = `[${timestamp}] [desktop/api] process exited with code=${code} signal=${signal}\n`;
    
    if (logStreamHealthy) {
      logStream.write(exitMsg);
      logStream.end();
    }
  });

  return child;
}

export function stopApiProcess(child: ChildProcessWithoutNullStreams | null | undefined) {
  if (!child || child.killed) return;
  child.kill('SIGTERM');

  const forceKillTimeout = setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGKILL');
    }
  }, 3000);

  child.once('exit', () => clearTimeout(forceKillTimeout));
}
