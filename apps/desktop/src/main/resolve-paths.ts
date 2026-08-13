import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from 'electron';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the compiled desktop output (apps/desktop/dist) */
export const desktopDistRoot = resolve(__dirname, '../..');

/** Compiled API binary name inside resources/bin/ (extraResources) */
function apiBinaryName(): string {
  return process.platform === 'win32' ? 'piplus-api.exe' : 'piplus-api';
}

/** Where the compiled API binary lives in production (extraResources → bin/) */
function prodApiBinaryPath(): string {
  return resolve(process.resourcesPath, 'bin', apiBinaryName());
}

/** Where the web build lives in production (extraResources) */
function prodWebDist() {
  return resolve(process.resourcesPath, 'web-dist');
}

// ---------------------------------------------------------------------------
// development paths (repo-relative from dist/main/)
// ---------------------------------------------------------------------------

export const repoRoot = resolve(__dirname, '../../../../');

// ---------------------------------------------------------------------------
// public helpers
// ---------------------------------------------------------------------------

/** TypeScript entrypoint used in development mode (spawned with bun). */
export function getApiEntryPath(): string {
  return resolve(repoRoot, 'apps/api/src/index.ts');
}

/**
 * Command used to launch the API.
 * - Packaged: the compiled single-file binary (bun build --compile), runs directly.
 * - Development: bun + TypeScript entrypoint.
 */
export function getApiCommand(): { command: string; args: string[] } {
  if (app.isPackaged) {
    return { command: prodApiBinaryPath(), args: [] };
  }
  return { command: resolveBunExecutable(), args: [getApiEntryPath()] };
}

export function getApiCwd(): string {
  return app.isPackaged ? resolve(process.resourcesPath, 'bin') : repoRoot;
}

export function getWebDistIndexPath(): string {
  return resolve(getWebProdDir(), 'index.html');
}

export function getWebProdDir(): string {
  return app.isPackaged
    ? prodWebDist()
    : resolve(repoRoot, 'apps/web/dist');
}

export function getPreloadPath(): string {
  return resolve(desktopDistRoot, 'preload/index.js');
}

/**
 * Resolve the Bun executable for development mode.
 *
 * Resolution order:
 * 1. `PIPLUS_BUN_PATH` environment variable (explicit override)
 * 2. `'bun'` (expect system PATH)
 */
export function resolveBunExecutable(): string {
  return process.env.PIPLUS_BUN_PATH ?? 'bun';
}
