import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';

function makeDbPath() {
  return `/tmp/piplus-models-${crypto.randomUUID()}.sqlite`;
}

async function login(app: ReturnType<typeof createApp>) {
  const tokenRes = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: Bun.env.APP_PASSWORD ?? 'piplus-local' }),
  });
  const { token } = await tokenRes.json();
  return token as string;
}

describe('model routes', () => {
  const originalHome = process.env.HOME;
  let tempHome = '';

  beforeEach(async () => {
    tempHome = await mkdtemp(join(tmpdir(), 'piplus-home-'));
    process.env.HOME = tempHome;
    await mkdir(join(tempHome, '.pi', 'agent'), { recursive: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    if (tempHome) await rm(tempHome, { recursive: true, force: true });
    mock.restore();
  });

  test('returns available models', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const token = await login(app);
    const res = await app.request('/api/v1/models', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.models)).toBe(true);
    for (const model of body.models) {
      expect(model).toHaveProperty('provider');
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('label');
    }
  });

  test('tests provider connection via /models endpoint', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://example.com/v1/models') {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-key');
        return new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini', name: 'GPT 4.1 Mini' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return originalFetch(input as RequestInfo | URL, init);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const res = await app.request('/api/v1/models/providers/test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerKey: 'custom-openai',
        baseUrl: 'https://example.com/v1/',
        apiKey: 'secret-key',
        authHeader: true,
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.models).toEqual([{ id: 'gpt-4.1-mini', name: 'GPT 4.1 Mini' }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.com/v1/models');
  });

  test('saves provider config and rejects duplicate keys', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    const res = await app.request('/api/v1/models/providers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerKey: 'custom-openai',
        baseUrl: 'https://example.com/v1',
        apiKey: 'secret-key',
        authHeader: true,
        compat: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: false,
        },
        models: [
          {
            id: 'gpt-4.1-mini',
            name: 'GPT 4.1 Mini',
            reasoning: true,
            inputImage: true,
            contextWindow: 128000,
            maxTokens: 32768,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const saved = JSON.parse(await readFile(join(tempHome, '.pi', 'agent', 'models.json'), 'utf-8'));
    expect(saved.providers['custom-openai']).toEqual({
      api: 'openai-completions',
      baseURL: 'https://example.com/v1',
      apiKey: 'secret-key',
      authHeader: true,
      compat: {
        supportsDeveloperRole: true,
        supportsReasoningEffort: false,
      },
      models: [
        {
          id: 'gpt-4.1-mini',
          name: 'GPT 4.1 Mini',
          reasoning: true,
          contextWindow: 128000,
          maxTokens: 32768,
          input: ['text', 'image'],
        },
      ],
    });

    const conflict = await app.request('/api/v1/models/providers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerKey: 'custom-openai',
        baseUrl: 'https://example.com/v1',
        models: [{ id: 'gpt-4.1-mini' }],
      }),
    });

    expect(conflict.status).toBe(409);
  });
});
