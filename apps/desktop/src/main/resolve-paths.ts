import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app } from 'electron';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Path to the compiled desktop output (apps/desktop/dist) */
export const desktopDistRoot = resolve(__dirname, '../..');

/** Where the bundled API lives in production (extraResources) */
function prodApiDist() {
  return resolve(process.resourcesPath, 'api-dist');
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

export function getApiEntryPath(): string {
  return app.isPackaged
    ? resolve(prodApiDist(), 'index.js')
    : resolve(repoRoot, 'apps/api/src/index.ts');
}

export function getApiCwd(): string {
  return app.isPackaged ? prodApiDist() : repoRoot;
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
 * Resolve the Bun executable path.
 *
 * Resolution order:
 * 1. `PIPLUS_BUN_PATH` environment variable (explicit override)
 * 2. Packaged app: `process.resourcesPath/bun-bin/bun.exe` (Windows)
 *    or `process.resourcesPath/bun-bin/bun` (Linux/macOS)
 * 3. Fallback to `'bun'` (expect system PATH)
 */
export function resolveBunExecutable(): string {
  const envPath = process.env.PIPLUS_BUN_PATH;
  if (envPath) return envPath;

  if (app.isPackaged) {
    const binName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    const bundledPath = resolve(process.resourcesPath, 'bun-bin', binName);
    if (existsSync(bundledPath)) {
      return bundledPath;
    }
    console.warn(
      `[desktop] Bundled bun not found at ${bundledPath}; ` +
      `falling back to system 'bun'. ` +
      `Set PIPLUS_BUN_PATH or rebuild with bun-bin/${binName}.`
    );
  }

  return 'bun';
}
