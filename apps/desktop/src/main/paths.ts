import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

export type AppPaths = {
  dataDir: string;
  logsDir: string;
  runtimeDir: string;
  cacheDir: string;
  projectsDir: string;
  databasePath: string;
};

export async function ensureAppPaths(): Promise<AppPaths> {
  const dataDir = app.getPath('userData');
  const logsDir = join(dataDir, 'logs');
  const runtimeDir = join(dataDir, 'runtime');
  const cacheDir = join(dataDir, 'cache');
  const projectsDir = join(dataDir, 'projects');
  const databasePath = join(dataDir, 'app.db');

  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(logsDir, { recursive: true }),
    mkdir(runtimeDir, { recursive: true }),
    mkdir(cacheDir, { recursive: true }),
    mkdir(projectsDir, { recursive: true }),
  ]);

  return { dataDir, logsDir, runtimeDir, cacheDir, projectsDir, databasePath };
}
