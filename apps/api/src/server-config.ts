import { join } from 'node:path';

type RuntimeEnv = Record<string, string | undefined>;

/** Default auth token lifetime in hours (7 days). Single source of truth. */
export const DEFAULT_TOKEN_TTL_HOURS = 168;

export type ServerConfig = {
  host: string;
  port: number;
  homeDir: string;
  dataDir: string;
  databaseUrl: string;
  databasePath: string;
  projectsRoot: string;
  logLevel?: string;
  nodeEnv?: string;
  appPassword?: string;
  /** Auth token lifetime in hours (env: APP_TOKEN_TTL). */
  appTokenTtlHours?: number;
};

function getRuntimeEnv(): RuntimeEnv {
  if (typeof Bun !== 'undefined') return Bun.env;
  return process.env;
}

function resolvePort(raw: string | undefined) {
  const parsed = Number(raw ?? 3001);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 3001;
}

function resolveTokenTtlHours(raw: string | undefined) {
  if (raw === undefined || raw === '') return DEFAULT_TOKEN_TTL_HOURS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TOKEN_TTL_HOURS;
}

function fileUrlToPath(url: string) {
  return url.startsWith('file:') ? url.slice('file:'.length) : url;
}

export function getServerConfig(env: RuntimeEnv = getRuntimeEnv()): ServerConfig {
  const homeDir = env.HOME ?? process.env.HOME ?? '/tmp';
  const dataDir = env.PIPLUS_DATA_DIR ?? join(homeDir, '.config', 'piplus');
  const databaseUrl = env.DATABASE_URL ?? `file:${join(dataDir, 'app.db')}`;
  const databasePath = fileUrlToPath(databaseUrl);

  return {
    host: env.API_HOST ?? '127.0.0.1',
    port: resolvePort(env.API_PORT),
    homeDir,
    dataDir,
    databaseUrl,
    databasePath,
    projectsRoot: env.PROJECTS_ROOT ?? join(dataDir, 'projects'),
    logLevel: env.LOG_LEVEL,
    nodeEnv: env.NODE_ENV,
    appPassword: env.APP_PASSWORD,
    appTokenTtlHours: resolveTokenTtlHours(env.APP_TOKEN_TTL),
  };
}

export function getDatabasePath() {
  return getServerConfig().databasePath;
}
