import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve } from 'node:path';
import type { AppPaths } from './paths.js';
import { getApiCwd, getApiEntryPath, repoRoot } from './resolve-paths.js';

export type ApiProcessOptions = {
  port: number;
  paths: AppPaths;
  appPassword?: string;
  webDistDir?: string;
};

export function startApiProcess(options: ApiProcessOptions): ChildProcessWithoutNullStreams {
  const bunExecutable = process.env.PIPLUS_BUN_PATH ?? 'bun';
  const webDistDir = options.webDistDir ?? resolve(repoRoot, 'apps/web/dist');

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
      ...(options.appPassword ? { APP_PASSWORD: options.appPassword } : {}),
    },
    stdio: 'pipe',
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[desktop/api] ${chunk}`);
  });

  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[desktop/api] ${chunk}`);
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
