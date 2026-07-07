import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '../../..');
// const electronDist = resolve(root, 'node_modules/.bun/electron@42.4.1/node_modules/electron/dist');
const webDistIndex = resolve(root, 'apps/web/dist/index.html');

const require = createRequire(import.meta.url);

// 用 require.resolve 找到 electron 包的真实位置（自动处理 bun 的符号链接和版本号）
let electronDist;
try {
  const electronPkgPath = require.resolve('electron/package.json');
  electronDist = resolve(dirname(electronPkgPath), 'dist');
} catch {
  electronDist = null;
}

if (!existsSync(electronDist)) {
  console.error('[desktop] Electron binary is missing. Please reinstall electron or run npm/bun postinstall for electron.');
  process.exit(1);
}

if (!existsSync(webDistIndex) && !process.env.PIPLUS_WEB_DEV_URL) {
  console.error('[desktop] apps/web/dist/index.html is missing. Build web first or set PIPLUS_WEB_DEV_URL.');
  process.exit(1);
}

console.log('[desktop] dev-check passed');
