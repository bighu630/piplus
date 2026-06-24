import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const electronDist = resolve(root, 'node_modules/.bun/electron@42.4.1/node_modules/electron/dist');
const webDistIndex = resolve(root, 'apps/web/dist/index.html');

if (!existsSync(electronDist)) {
  console.error('[desktop] Electron binary is missing. Please reinstall electron or run npm/bun postinstall for electron.');
  process.exit(1);
}

if (!existsSync(webDistIndex) && !process.env.PIPLUS_WEB_DEV_URL) {
  console.error('[desktop] apps/web/dist/index.html is missing. Build web first or set PIPLUS_WEB_DEV_URL.');
  process.exit(1);
}

console.log('[desktop] dev-check passed');
