import { afterEach, describe, expect, test } from 'bun:test';

const KEYS = [
  'API_HOST',
  'API_PORT',
  'DATABASE_URL',
  'PIPLUS_DATA_DIR',
  'PROJECTS_ROOT',
  'HOME',
] as const;

type EnvKey = typeof KEYS[number];

const originalEnv = new Map<EnvKey, string | undefined>(
  KEYS.map((key) => [key, Bun.env[key]]),
);

function restoreEnv() {
  for (const key of KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) {
      delete Bun.env[key];
    } else {
      Bun.env[key] = value;
    }
  }
}

afterEach(() => {
  restoreEnv();
});

describe('server config', () => {
  test('uses explicit host and port env values', async () => {
    Bun.env.API_HOST = '127.0.0.1';
    Bun.env.API_PORT = '4567';
    delete Bun.env.DATABASE_URL;
    delete Bun.env.PIPLUS_DATA_DIR;

    const { getServerConfig } = await import('./server-config');
    const config = getServerConfig();

    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(4567);
  });

  test('derives database path from PIPLUS_DATA_DIR when DATABASE_URL is unset', async () => {
    delete Bun.env.DATABASE_URL;
    Bun.env.PIPLUS_DATA_DIR = '/tmp/piplus-data';

    const { getServerConfig } = await import(`./server-config?case=${crypto.randomUUID()}`);
    const config = getServerConfig();

    expect(config.dataDir).toBe('/tmp/piplus-data');
    expect(config.databaseUrl).toBe('file:/tmp/piplus-data/app.db');
    expect(config.databasePath).toBe('/tmp/piplus-data/app.db');
  });

  test('uses explicit DATABASE_URL over derived default', async () => {
    Bun.env.PIPLUS_DATA_DIR = '/tmp/piplus-data';
    Bun.env.DATABASE_URL = 'file:/tmp/custom.sqlite';

    const { getServerConfig } = await import(`./server-config?case=${crypto.randomUUID()}`);
    const config = getServerConfig();

    expect(config.databaseUrl).toBe('file:/tmp/custom.sqlite');
    expect(config.databasePath).toBe('/tmp/custom.sqlite');
  });

  test('derives projects root from HOME when PROJECTS_ROOT is unset', async () => {
    Bun.env.HOME = '/tmp/piplus-home';
    delete Bun.env.PROJECTS_ROOT;

    const { getServerConfig } = await import(`./server-config?case=${crypto.randomUUID()}`);
    const config = getServerConfig();

    expect(config.projectsRoot).toBe('/tmp/piplus-home/.config/piplus/projects');
  });
});
