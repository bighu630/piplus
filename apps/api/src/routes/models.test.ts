import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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

/** Path to the piplus-managed models file under a temp HOME */
function piplusModelsPath(home: string) {
  return join(home, '.config', 'piplus', 'piplus-models.json');
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

  test('saves provider config to piplus-models.json and rejects duplicate keys', async () => {
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
    // Data should be saved in piplus-models.json, NOT pi's models.json
    const saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    expect(saved.providers['custom-openai']).toEqual({
      api: 'openai-completions',
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

  test('detects provider key collision with pi models.json', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    // Put a provider in pi's models.json (to verify collision detection)
    const piModelsPath = join(tempHome, '.pi', 'agent', 'models.json');
    await writeFile(
      piModelsPath,
      JSON.stringify({ providers: { 'pi-managed': { api: 'openai-completions', baseUrl: 'https://pi.example.com', apiKey: 'sk-pi' } } }, null, 2),
    );

    const conflict = await app.request('/api/v1/models/providers', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        providerKey: 'pi-managed',
        baseUrl: 'https://other.example.com',
        apiKey: 'sk-other',
        models: [{ id: 'test-model' }],
      }),
    });

    expect(conflict.status).toBe(409);
  });

  test('saves provider with all optional fields (api, headers, cost, compat, thinkingLevelMap, input)', async () => {
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
        providerKey: 'advanced-llm',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-advanced',
        authHeader: true,
        api: 'anthropic-messages',
        headers: { 'x-custom': 'value1' },
        compat: {
          supportsDeveloperRole: true,
          supportsReasoningEffort: true,
          supportsUsageInStreaming: false,
          maxTokensField: 'max_tokens',
        },
        models: [
          {
            id: 'claude-opus-4',
            name: 'Claude Opus 4',
            reasoning: true,
            contextWindow: 200000,
            maxTokens: 4096,
            input: ['text', 'image'],
            cost: { input: 15, output: 75, cacheRead: 7.5, cacheWrite: 15 },
            compat: {
              forceAdaptiveThinking: true,
            },
            thinkingLevelMap: {
              off: null,
              medium: 'medium',
              high: 'high',
            },
          },
          {
            id: 'claude-sonnet-4',
            name: 'Claude Sonnet 4',
            reasoning: false,
            inputImage: true,
          },
        ],
      }),
    });

    expect(res.status).toBe(200);
    const saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    const provider = saved.providers['advanced-llm'];

    expect(provider.api).toBe('anthropic-messages');
    expect(provider.baseUrl).toBe('https://api.example.com/v1');
    expect(provider.headers).toEqual({ 'x-custom': 'value1' });
    expect(provider.compat).toEqual({
      supportsDeveloperRole: true,
      supportsReasoningEffort: true,
      supportsUsageInStreaming: false,
      maxTokensField: 'max_tokens',
    });

    expect(provider.models).toHaveLength(2);

    // First model: explicit input
    expect(provider.models[0]).toEqual({
      id: 'claude-opus-4',
      name: 'Claude Opus 4',
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 4096,
      input: ['text', 'image'],
      cost: { input: 15, output: 75, cacheRead: 7.5, cacheWrite: 15 },
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: {
        off: null,
        medium: 'medium',
        high: 'high',
      },
    });

    // Second model: inputImage shorthand, reasoning=false persisted
    expect(provider.models[1]).toEqual({
      id: 'claude-sonnet-4',
      name: 'Claude Sonnet 4',
      reasoning: false,
      input: ['text', 'image'],
    });
  });
});
