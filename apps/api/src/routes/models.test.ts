import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hono } from 'hono';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';
import { registerModelRoutes } from './models';

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

/** Create a piplus-managed provider via the POST endpoint */
// NOTE: every provider/model registered here must expose input including 'image'.
// bun runs all test files in ONE process sharing pi's model registry, and
// sessions.test.ts picks its image-capable model from the registry tail
// (models.at(-1)) — a trailing text-only model breaks those tests.
async function postProvider(app: ReturnType<typeof createApp>, token: string, body: Record<string, unknown>) {
  return app.request('/api/v1/models/providers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
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

  test('GET providers returns an empty list when piplus-models.json does not exist', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    const res = await app.request('/api/v1/models/providers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.providers).toEqual([]);
  });

  test('GET providers lists saved providers sorted by key without apiKey', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    await postProvider(app, token, {
      providerKey: 'zeta-llm',
      baseUrl: 'https://zeta.example.com/v1',
      apiKey: 'zeta-secret',
      models: [{ id: 'zeta-model', input: ['text', 'image'] }],
    });
    await postProvider(app, token, {
      providerKey: 'alpha-llm',
      baseUrl: 'https://alpha.example.com/v1',
      apiKey: 'alpha-secret',
      authHeader: true,
      models: [{ id: 'alpha-model', name: 'Alpha Model', reasoning: true, contextWindow: 100000, input: ['text', 'image'] }],
    });

    const res = await app.request('/api/v1/models/providers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.providers.map((p: { providerKey: string }) => p.providerKey)).toEqual(['alpha-llm', 'zeta-llm']);

    for (const provider of body.providers) {
      // apiKey must never leak, neither at provider nor model level
      expect(Object.keys(provider)).not.toContain('apiKey');
      expect(provider.baseUrl).toMatch(/^https:\/\//);
      expect(typeof provider.authHeader).toBe('boolean');
      expect(Array.isArray(provider.models)).toBe(true);
      for (const model of provider.models) {
        expect(Object.keys(model)).not.toContain('apiKey');
        expect(model.id).toBeTruthy();
      }
    }

    const alpha = body.providers.find((p: { providerKey: string }) => p.providerKey === 'alpha-llm');
    expect(alpha.models[0]).toMatchObject({
      id: 'alpha-model',
      name: 'Alpha Model',
      reasoning: true,
      contextWindow: 100000,
      input: ['text', 'image'],
    });
  });

  test('PUT keeps stored apiKey when body apiKey is empty and overwrites when provided', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    await postProvider(app, token, {
      providerKey: 'custom-openai',
      baseUrl: 'https://example.com/v1',
      apiKey: 'original-secret',
      authHeader: true,
      models: [{ id: 'gpt-4.1-mini', input: ['text', 'image'] }],
    });

    // PUT without apiKey field → keeps the stored key
    const res = await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        baseUrl: 'https://updated.example.com/v1',
        models: [{ id: 'new-model', name: 'New Model', input: ['text', 'image'] }, { id: 'gpt-4.1-mini', input: ['text', 'image'] }],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.providerKey).toBe('custom-openai');
    expect(body.models.some((m: { id: string }) => m.id === 'new-model')).toBe(true);

    let saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    expect(saved.providers['custom-openai'].apiKey).toBe('original-secret');
    expect(saved.providers['custom-openai'].baseUrl).toBe('https://updated.example.com/v1');
    expect(saved.providers['custom-openai'].models.map((m: { id: string }) => m.id)).toEqual(['new-model', 'gpt-4.1-mini']);

    // PUT with apiKey: '' → still keeps the stored key
    await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        baseUrl: 'https://updated.example.com/v1',
        apiKey: '',
        models: [{ id: 'new-model', input: ['text', 'image'] }],
      }),
    });
    saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    expect(saved.providers['custom-openai'].apiKey).toBe('original-secret');

    // PUT with a new apiKey → overwrites
    await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        baseUrl: 'https://updated.example.com/v1',
        apiKey: 'new-secret',
        models: [{ id: 'new-model', input: ['text', 'image'] }],
      }),
    });
    saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    expect(saved.providers['custom-openai'].apiKey).toBe('new-secret');
  });

  test('PUT with a whitespace-only apiKey keeps the stored key', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    await postProvider(app, token, {
      providerKey: 'custom-openai',
      baseUrl: 'https://example.com/v1',
      apiKey: 'original-secret',
      authHeader: true,
      models: [{ id: 'gpt-4.1-mini', input: ['text', 'image'] }],
    });

    // PUT with apiKey: '   ' (pure whitespace) → trims to '' → keeps the stored key
    const res = await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        baseUrl: 'https://updated.example.com/v1',
        apiKey: '   ',
        models: [{ id: 'new-model', input: ['text', 'image'] }],
      }),
    });
    expect(res.status).toBe(200);

    const saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    expect(saved.providers['custom-openai'].apiKey).toBe('original-secret');
    expect(saved.providers['custom-openai'].baseUrl).toBe('https://updated.example.com/v1');
  });

  test('PUT returns 404 for unknown provider and 400 for invalid bodies', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    // Unknown provider → 404
    const missing = await app.request('/api/v1/models/providers/ghost', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ baseUrl: 'https://x.example.com', models: [{ id: 'm' }] }),
    });
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe('PROVIDER_NOT_FOUND');

    await postProvider(app, token, {
      providerKey: 'custom-openai',
      baseUrl: 'https://example.com/v1',
      models: [{ id: 'gpt-4.1-mini', input: ['text', 'image'] }],
    });

    // Empty models → 400
    const emptyModels = await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ baseUrl: 'https://example.com/v1', models: [] }),
    });
    expect(emptyModels.status).toBe(400);
    expect((await emptyModels.json()).error.code).toBe('INVALID_MODELS');

    // Missing baseUrl → 400
    const noBaseUrl = await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ models: [{ id: 'gpt-4.1-mini' }] }),
    });
    expect(noBaseUrl.status).toBe(400);
    expect((await noBaseUrl.json()).error.code).toBe('INVALID_BASE_URL');
  });

  test('PUT leaves the file untouched when registerProvider throws', async () => {
    // Fake piClient whose registerProvider always throws, simulating a
    // failed registration (invalid config) on the Pi registry side.
    const throwingClient = {
      registerProvider: async () => {
        throw new Error('registration boom');
      },
      listAvailableModels: async () => [],
    } as unknown as Parameters<typeof registerModelRoutes>[1];

    const app = new Hono();
    registerModelRoutes(app, throwingClient);

    // Seed the file directly (POST can't succeed with a throwing client)
    const modelsPath = piplusModelsPath(tempHome);
    await mkdir(join(tempHome, '.config', 'piplus'), { recursive: true });
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          'custom-openai': {
            api: 'openai-completions',
            baseUrl: 'https://example.com/v1',
            apiKey: 'original-secret',
            authHeader: true,
            models: [{ id: 'gpt-4.1-mini', input: ['text', 'image'] }],
          },
        },
      }, null, 2),
      'utf-8',
    );

    const res = await app.request('/api/v1/models/providers/custom-openai', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        baseUrl: 'https://should-not-be-written.example.com/v1',
        models: [{ id: 'new-model', input: ['text', 'image'] }],
      }),
    });
    expect(res.status).toBe(500);

    // Disk untouched: registration failed before any write
    const saved = JSON.parse(await readFile(modelsPath, 'utf-8'));
    expect(saved.providers['custom-openai'].apiKey).toBe('original-secret');
    expect(saved.providers['custom-openai'].baseUrl).toBe('https://example.com/v1');
  });

  test('DELETE removes the provider from the file and from GET, keeping others intact', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    await postProvider(app, token, {
      providerKey: 'alpha-llm',
      baseUrl: 'https://alpha.example.com/v1',
      models: [{ id: 'alpha-model', input: ['text', 'image'] }],
    });
    await postProvider(app, token, {
      providerKey: 'zeta-llm',
      baseUrl: 'https://zeta.example.com/v1',
      // input must include 'image' so the shared process-wide model registry
      // snapshot's trailing models stay image-capable for sessions.test.ts,
      // which picks its image-capable model from the registry tail (at(-1))
      models: [{ id: 'zeta-model', input: ['text', 'image'] }],
    });

    const res = await app.request('/api/v1/models/providers/alpha-llm', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, providerKey: 'alpha-llm' });

    // File still valid JSON: alpha gone, zeta retained
    const saved = JSON.parse(await readFile(piplusModelsPath(tempHome), 'utf-8'));
    expect(saved.providers['alpha-llm']).toBeUndefined();
    expect(saved.providers['zeta-llm']).toBeDefined();

    // GET no longer returns the deleted provider
    const listRes = await app.request('/api/v1/models/providers', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const listBody = await listRes.json();
    expect(listBody.providers.map((p: { providerKey: string }) => p.providerKey)).toEqual(['zeta-llm']);
  });

  test('DELETE returns 404 for unknown provider', async () => {
    const path = makeDbPath();
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const token = await login(app);

    const res = await app.request('/api/v1/models/providers/ghost', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('PROVIDER_NOT_FOUND');
  });
});
