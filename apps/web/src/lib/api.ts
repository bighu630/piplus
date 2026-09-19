// Barrel: domain modules live in `./api/*` (see each file for the implementation).
// `./api/client` holds the shared private `request()` helper and is intentionally
// not re-exported here (it was never part of this module's public surface).
export * from './api/auth';
export * from './api/ask';
export * from './api/models';
export * from './api/sessions';
export * from './api/projects';
export * from './api/files-git';
export * from './api/packages';
export * from './api/todos';
export * from './api/roles-settings';
