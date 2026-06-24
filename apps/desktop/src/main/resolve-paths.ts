import { app } from 'electron';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
