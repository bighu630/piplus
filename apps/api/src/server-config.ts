import { join } from 'node:path';

type RuntimeEnv = Record<string, string | undefined>;

/** Default auth token lifetime in hours (7 days). Single source of truth. */
export const DEFAULT_TOKEN_TTL_HOURS = 168;

/** Default global login failure cap per window. Single source of truth. */
export const DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS = 100;

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
  /** Allow the x-user-id dev fallback in non-production (env: PIPLUS_DEV_AUTH === '1'). */
  devAuth?: boolean;
  /** Comma-separated list of trusted reverse-proxy CIDRs (env: TRUST_PROXY_CIDRS). */
  trustProxyCidrs?: string[];
  /** Max failed logins per window across all clients (env: LOGIN_GLOBAL_MAX_ATTEMPTS). */
  loginGlobalMaxAttempts?: number;
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

function parseTrustProxyCidrs(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  return raw
    .split(',')
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr !== '');
}

function resolveLoginGlobalMaxAttempts(raw: string | undefined) {
  if (raw === undefined || raw === '') return DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_LOGIN_GLOBAL_MAX_ATTEMPTS;
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
    devAuth: env.PIPLUS_DEV_AUTH === '1',
    trustProxyCidrs: parseTrustProxyCidrs(env.TRUST_PROXY_CIDRS),
    loginGlobalMaxAttempts: resolveLoginGlobalMaxAttempts(env.LOGIN_GLOBAL_MAX_ATTEMPTS),
  };
}

export function getDatabasePath() {
  return getServerConfig().databasePath;
}
