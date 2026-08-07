import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import type { Hono } from 'hono';
import { createPiClient } from '@piplus/pi-client';

type ProviderTestBody = {
  providerKey?: string;
  baseUrl?: string;
  apiKey?: string;
  authHeader?: boolean;
};

type ProviderModelInput = {
  id?: string;
  name?: string;
  reasoning?: boolean;
  inputImage?: boolean;
  input?: string[];
  api?: string;
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
};

type ProviderCreateBody = ProviderTestBody & {
  api?: string;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models?: ProviderModelInput[];
};

type StoredModelsFile = {
  providers: Record<string, Record<string, unknown>>;
};

type ValidatedProviderBasics = {
  providerKey: string;
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
};

/** A provider as returned by GET /api/v1/models/providers (never includes apiKey) */
type ProviderModelListItem = {
  id: string;
  name?: string;
  api?: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  compat?: Record<string, unknown>;
  thinkingLevelMap?: Record<string, string | null>;
};

type ProviderListItem = {
  providerKey: string;
  baseUrl: string;
  api?: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: ProviderModelListItem[];
};

/** Payload shape passed to piClient.registerProvider */
type ProviderRegistrationConfig = {
  api: string;
  baseUrl: string;
  apiKey: string;
  authHeader: boolean;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
  models: Array<{
    id: string;
    name?: string;
    api?: string;
    reasoning: boolean;
    thinkingLevelMap?: Record<string, string | null>;
    input: string[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    compat?: Record<string, unknown>;
  }>;
};

/** Piplus-managed providers file */
function getPiplusModelsFilePath() {
  const configDir = process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'piplus')
    : join(process.env.HOME || homedir(), '.config', 'piplus');
  return join(configDir, 'piplus-models.json');
}

/** Pi's own models.json — read-only from piplus side, for duplicate checking */
function getPiModelsFilePath() {
  return join(process.env.HOME || homedir(), '.pi', 'agent', 'models.json');
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function buildHeaders(apiKey: string, authHeader: boolean): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (authHeader && apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ''))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ''));
}

/** Read piplus-managed providers from the separate piplus-models.json */
async function readPiplusModelsConfig(): Promise<StoredModelsFile> {
  try {
    const raw = await readFile(getPiplusModelsFilePath(), 'utf-8');
    const parsed = JSON.parse(stripJsonComments(raw)) as Partial<StoredModelsFile>;
    return { providers: parsed.providers ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { providers: {} };
    }
    throw error;
  }
}

/** Write only piplus-managed providers to the separate piplus-models.json (atomic: temp + rename) */
async function writePiplusModelsConfig(content: StoredModelsFile) {
  const filePath = getPiplusModelsFilePath();
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
  await rename(tmpPath, filePath);
}

/** Check if a provider key already exists in either pi's models.json or piplus-models.json */
async function isProviderKeyTaken(providerKey: string): Promise<boolean> {
  // Check piplus's own file first
  const piplusConfig = await readPiplusModelsConfig();
  if (piplusConfig.providers[providerKey]) return true;

  // Also check pi's models.json to avoid collisions
  try {
    const raw = await readFile(getPiModelsFilePath(), 'utf-8');
    const parsed = JSON.parse(stripJsonComments(raw)) as Partial<StoredModelsFile>;
    if (parsed.providers?.[providerKey]) return true;
  } catch {
    // If pi's models.json doesn't exist or can't be read, ignore
  }

  return false;
}

function validateProviderBasics(body: ProviderTestBody) {
  const providerKey = String(body.providerKey ?? '').trim();
  const baseUrl = normalizeBaseUrl(String(body.baseUrl ?? '').trim());
  const apiKey = String(body.apiKey ?? '').trim();
  const authHeader = Boolean(body.authHeader);

  if (!providerKey) {
    return { error: { code: 'INVALID_PROVIDER_KEY', message: 'providerKey is required' }, status: 400 as const };
  }
  if (!baseUrl) {
    return { error: { code: 'INVALID_BASE_URL', message: 'baseUrl is required' }, status: 400 as const };
  }

  return { providerKey, baseUrl, apiKey, authHeader };
}

/** Validate that a create/update body has at least one model with a non-empty id */
function validateProviderModels(body: ProviderCreateBody) {
  const models = Array.isArray(body.models) ? body.models : [];
  if (models.length === 0) {
    return { error: { code: 'INVALID_MODELS', message: 'At least one model is required' }, status: 400 as const };
  }

  const invalidModel = models.find((model) => !String(model.id ?? '').trim());
  if (invalidModel) {
    return { error: { code: 'INVALID_MODEL_ID', message: 'Each model id is required' }, status: 400 as const };
  }

  return { models };
}

/**
 * Build the provider config persisted to piplus-models.json.
 * apiKey semantics: an empty/undefined body.apiKey keeps the stored key (existingApiKey),
 * a non-empty body.apiKey overwrites it.
 */
function buildProviderConfig(
  body: ProviderCreateBody,
  validated: ValidatedProviderBasics,
  existingApiKey?: string,
): Record<string, unknown> {
  const providerConfig: Record<string, unknown> = {
    api: body.api?.trim() || 'openai-completions',
    baseUrl: validated.baseUrl,
    apiKey: validated.apiKey || existingApiKey || '',
    authHeader: validated.authHeader,
  };

  if (body.headers && Object.keys(body.headers).length > 0) {
    providerConfig.headers = body.headers;
  }

  if (body.compat && Object.keys(body.compat).length > 0) {
    providerConfig.compat = body.compat;
  }

  providerConfig.models = (Array.isArray(body.models) ? body.models : []).map((model) => {
    const modelEntry: Record<string, unknown> = {
      id: String(model.id).trim(),
    };

    if (model.name?.trim()) {
      modelEntry.name = model.name.trim();
    }

    if (model.api?.trim()) {
      modelEntry.api = model.api.trim();
    }

    if (model.reasoning !== undefined) {
      modelEntry.reasoning = model.reasoning;
    }

    if (model.contextWindow) {
      modelEntry.contextWindow = Number(model.contextWindow);
    }

    if (model.maxTokens) {
      modelEntry.maxTokens = Number(model.maxTokens);
    }

    if (model.cost) {
      const cost: Record<string, number> = {};
      if (model.cost.input != null) cost.input = Number(model.cost.input);
      if (model.cost.output != null) cost.output = Number(model.cost.output);
      if (model.cost.cacheRead != null) cost.cacheRead = Number(model.cost.cacheRead);
      if (model.cost.cacheWrite != null) cost.cacheWrite = Number(model.cost.cacheWrite);
      if (Object.keys(cost).length > 0) modelEntry.cost = cost;
    }

    if (model.compat && Object.keys(model.compat).length > 0) {
      modelEntry.compat = model.compat;
    }

    if (model.thinkingLevelMap && Object.keys(model.thinkingLevelMap).length > 0) {
      modelEntry.thinkingLevelMap = model.thinkingLevelMap;
    }

    // input: prefer explicit input array over inputImage shorthand
    if (model.input && Array.isArray(model.input) && model.input.length > 0) {
      modelEntry.input = model.input;
    } else if (model.inputImage) {
      modelEntry.input = ['text', 'image'];
    } else {
      modelEntry.input = ['text'];
    }

    return modelEntry;
  });

  return providerConfig;
}

/** Build the payload passed to piClient.registerProvider (full model replacement) */
function buildRegistrationConfig(
  body: ProviderCreateBody,
  validated: ValidatedProviderBasics,
  apiKey: string,
): ProviderRegistrationConfig {
  const models = Array.isArray(body.models) ? body.models : [];
  return {
    api: body.api?.trim() || 'openai-completions',
    baseUrl: validated.baseUrl,
    apiKey,
    authHeader: validated.authHeader,
    headers: body.headers,
    compat: body.compat,
    models: models.map((model) => ({
      id: String(model.id).trim(),
      name: model.name?.trim() || undefined,
      api: model.api?.trim() || undefined,
      reasoning: model.reasoning ?? false,
      thinkingLevelMap: model.thinkingLevelMap,
      input: model.input?.length
        ? model.input
        : model.inputImage
          ? ['text', 'image']
          : ['text'],
      cost: {
        input: model.cost?.input ?? 0,
        output: model.cost?.output ?? 0,
        cacheRead: model.cost?.cacheRead ?? 0,
        cacheWrite: model.cost?.cacheWrite ?? 0,
      },
      contextWindow: model.contextWindow ? Number(model.contextWindow) : 128000,
      maxTokens: model.maxTokens ? Number(model.maxTokens) : 16384,
      compat: model.compat as Record<string, unknown> | undefined,
    })),
  };
}

/** Register (or re-register) a provider with Pi's model registry. Returns false if unavailable. */
async function registerProviderConfig(
  piClient: ReturnType<typeof createPiClient>,
  providerKey: string,
  config: ProviderRegistrationConfig,
): Promise<boolean> {
  if (!piClient.registerProvider) return false;
  await piClient.registerProvider(providerKey, config);
  return true;
}

/** Normalize a stored provider entry for the API response, stripping apiKey and filling only present fields */
function normalizeProviderEntry(providerKey: string, raw: Record<string, unknown>): ProviderListItem {
  const entry: ProviderListItem = {
    providerKey,
    baseUrl: String(raw.baseUrl ?? ''),
    authHeader: Boolean(raw.authHeader),
    models: [],
  };

  if (raw.api) {
    entry.api = String(raw.api);
  }

  if (raw.headers && typeof raw.headers === 'object') {
    entry.headers = raw.headers as Record<string, string>;
  }

  if (raw.compat && typeof raw.compat === 'object') {
    entry.compat = raw.compat as Record<string, unknown>;
  }

  const models = Array.isArray(raw.models) ? raw.models : [];
  entry.models = models.map((m) => {
    const model = (m ?? {}) as Record<string, unknown>;
    const item: ProviderModelListItem = { id: String(model.id ?? '') };

    if (model.name) item.name = String(model.name);
    if (model.api) item.api = String(model.api);
    if (model.reasoning !== undefined) item.reasoning = Boolean(model.reasoning);
    if (Array.isArray(model.input) && model.input.length > 0) item.input = model.input as string[];
    if (model.contextWindow) item.contextWindow = Number(model.contextWindow);
    if (model.maxTokens) item.maxTokens = Number(model.maxTokens);
    if (model.cost && typeof model.cost === 'object') {
      item.cost = model.cost as ProviderModelListItem['cost'];
    }
    if (model.compat && typeof model.compat === 'object') {
      item.compat = model.compat as Record<string, unknown>;
    }
    if (model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object') {
      item.thinkingLevelMap = model.thinkingLevelMap as Record<string, string | null>;
    }

    return item;
  });

  return entry;
}

/** Re-register all piplus-managed providers with Pi's model registry at startup */
async function loadPiplusProviders(piClient: ReturnType<typeof createPiClient>) {
  if (!piClient.registerProvider) return;

  let config: StoredModelsFile;
  try {
    config = await readPiplusModelsConfig();
  } catch {
    return; // File doesn't exist or is unreadable — nothing to load
  }

  for (const [providerKey, providerConfig] of Object.entries(config.providers)) {
    const { api, baseUrl, apiKey, authHeader, headers, compat, models } = providerConfig as Record<string, unknown>;
    if (!api || !baseUrl) {
      console.warn(`[models] Skipping provider "${providerKey}": missing api or baseUrl`);
      continue;
    }

    try {
      piClient.registerProvider(providerKey, {
        api: api as string,
        baseUrl: baseUrl as string,
        apiKey: (apiKey as string) ?? '',
        authHeader: Boolean(authHeader),
        headers: headers as Record<string, string> | undefined,
        compat: compat as Record<string, unknown> | undefined,
        models: (models as Array<Record<string, unknown>> ?? []).map((m) => ({
          id: String(m.id),
          name: m.name as string | undefined,
          api: m.api as string | undefined,
          reasoning: (m.reasoning as boolean) ?? false,
          thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> | undefined,
          input: m.input as string[] | undefined,
          cost: (m.cost as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: (m.contextWindow as number) ?? 128000,
          maxTokens: (m.maxTokens as number) ?? 16384,
          compat: m.compat as Record<string, unknown> | undefined,
        })),
      });
    } catch (err) {
      console.warn(`[models] Failed to register provider "${providerKey}":`, err);
    }
  }
}

export function registerModelRoutes(
  app: Hono,
  piClient: ReturnType<typeof createPiClient> = createPiClient(),
) {
  // Load piplus-managed providers at startup — routes wait for this before handling requests
  const initPromise = loadPiplusProviders(piClient).catch((err) =>
    console.error('[models] Failed to load piplus providers at startup:', err),
  );

  app.get('/api/v1/models/status', async (c) => {
    await initPromise;
    const models = await piClient.listAvailableModels();
    return c.json({ ok: models.length > 0, count: models.length, models });
  });

  app.get('/api/v1/models', async (c) => {
    await initPromise;
    const models = await piClient.listAvailableModels();
    return c.json({ models });
  });

  app.post('/api/v1/models/providers/test', async (c) => {
    const body = await c.req.json().catch(() => ({})) as ProviderTestBody;
    const validated = validateProviderBasics(body);
    if ('error' in validated) return c.json({ error: validated.error }, validated.status);

    try {
      const response = await fetch(`${validated.baseUrl}/models`, {
        method: 'GET',
        headers: buildHeaders(validated.apiKey, validated.authHeader),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return c.json({ ok: false, error: errorText || `request_failed:${response.status}` }, 200);
      }

      const json = await response.json().catch(() => ({} as { data?: Array<{ id?: string; name?: string }> }));
      const models = Array.isArray((json as { data?: Array<{ id?: string; name?: string }> }).data)
        ? (json as { data: Array<{ id?: string; name?: string }> }).data
            .filter((item) => typeof item?.id === 'string' && item.id)
            .map((item) => ({ id: item.id!, name: item.name ?? item.id! }))
        : [];

      return c.json({ ok: true, models });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : 'unknown_error' });
    }
  });

  app.post('/api/v1/models/providers', async (c) => {
    const body = await c.req.json().catch(() => ({})) as ProviderCreateBody;
    const validated = validateProviderBasics(body);
    if ('error' in validated) return c.json({ error: validated.error }, validated.status);

    const modelsResult = validateProviderModels(body);
    if ('error' in modelsResult) return c.json({ error: modelsResult.error }, modelsResult.status);

    // Check both piplus and pi's models.json for duplicate provider keys
    if (await isProviderKeyTaken(validated.providerKey)) {
      return c.json({ error: { code: 'PROVIDER_EXISTS', message: 'Provider already exists' } }, 409);
    }

    // Build the provider config (same structure as pi's models.json expects)
    const providerConfig = buildProviderConfig(body, validated);

    // Register with Pi's model registry FIRST (may throw on invalid config).
    // If registration succeeds, models are immediately available for sessions.
    const registered = await registerProviderConfig(
      piClient,
      validated.providerKey,
      buildRegistrationConfig(body, validated, validated.apiKey),
    );
    if (!registered) {
      return c.json({ error: { code: 'REGISTRATION_FAILED', message: 'Provider registration is not available' } }, 500);
    }

    // Then persist to disk (if this fails, the provider is still registered in-memory
    // for the current process lifetime; restart will pick it up from the file)
    const config = await readPiplusModelsConfig();
    config.providers[validated.providerKey] = providerConfig;
    await writePiplusModelsConfig(config);

    // Return the newly registered models
    const refreshed = await piClient.listAvailableModels();
    const providerModels = refreshed.filter((model) => model.provider === validated.providerKey);
    return c.json({ ok: true, providerKey: validated.providerKey, models: providerModels });
  });

  // List piplus-managed custom providers (apiKey is never exposed)
  app.get('/api/v1/models/providers', async (c) => {
    await initPromise;
    const config = await readPiplusModelsConfig();
    const providers = Object.entries(config.providers)
      .map(([providerKey, providerConfig]) => normalizeProviderEntry(providerKey, providerConfig))
      .sort((a, b) => a.providerKey.localeCompare(b.providerKey));
    return c.json({ ok: true, providers });
  });

  // Update an existing piplus-managed custom provider (apiKey from URL, body identical to create)
  app.put('/api/v1/models/providers/:providerKey', async (c) => {
    await initPromise;
    const providerKey = String(c.req.param('providerKey') ?? '').trim();
    if (!providerKey) {
      return c.json({ error: { code: 'INVALID_PROVIDER_KEY', message: 'providerKey is required' } }, 400);
    }

    const body = await c.req.json().catch(() => ({})) as ProviderCreateBody;
    const validated = validateProviderBasics({ ...body, providerKey });
    if ('error' in validated) return c.json({ error: validated.error }, validated.status);

    const modelsResult = validateProviderModels(body);
    if ('error' in modelsResult) return c.json({ error: modelsResult.error }, modelsResult.status);

    const config = await readPiplusModelsConfig();
    const existing = config.providers[providerKey];
    if (!existing) {
      return c.json({ error: { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' } }, 404);
    }

    const existingApiKey =
      typeof existing.apiKey === 'string' ? existing.apiKey : undefined;

    // apiKey semantics: empty/undefined body.apiKey keeps the stored key, non-empty overwrites it
    const providerConfig = buildProviderConfig(body, validated, existingApiKey);

    // Register with Pi's model registry FIRST (may throw on invalid config).
    // If registration fails, the file has not been touched, keeping disk,
    // in-memory registry, and the user's view consistent — same as POST.
    const registered = await registerProviderConfig(
      piClient,
      providerKey,
      buildRegistrationConfig(body, validated, validated.apiKey || existingApiKey || ''),
    );
    if (!registered) {
      return c.json({ error: { code: 'REGISTRATION_FAILED', message: 'Provider registration is not available' } }, 500);
    }

    // Then persist to disk (if this fails, the provider is still registered in-memory
    // for the current process lifetime; restart will pick it up from the file)
    config.providers[providerKey] = providerConfig;
    await writePiplusModelsConfig(config);

    // Return the freshly registered models
    const refreshed = await piClient.listAvailableModels();
    const providerModels = refreshed.filter((model) => model.provider === providerKey);
    return c.json({ ok: true, providerKey, models: providerModels });
  });

  // Delete a piplus-managed custom provider. Deliberately no unregisterProvider call:
  // models registered in the current process are reclaimed by the runtime automatically,
  // and disappear on restart once the file no longer lists them.
  app.delete('/api/v1/models/providers/:providerKey', async (c) => {
    await initPromise;
    const providerKey = String(c.req.param('providerKey') ?? '').trim();
    if (!providerKey) {
      return c.json({ error: { code: 'INVALID_PROVIDER_KEY', message: 'providerKey is required' } }, 400);
    }

    const config = await readPiplusModelsConfig();
    if (!config.providers[providerKey]) {
      return c.json({ error: { code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' } }, 404);
    }

    delete config.providers[providerKey];
    await writePiplusModelsConfig(config);

    return c.json({ ok: true, providerKey });
  });

  // Native provider auth endpoints

  const NATIVE_PROVIDERS = [
    { provider: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY' },
    { provider: 'opencode', label: 'OpenCode Zen', env: 'OPENCODE_API_KEY' },
    { provider: 'opencode-go', label: 'OpenCode Go', env: 'OPENCODE_API_KEY' },
    { provider: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY' },
    { provider: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY' },
    { provider: 'deepseek', label: 'DeepSeek', env: 'DEEPSEEK_API_KEY' },
    { provider: 'google', label: 'Google Gemini', env: 'GOOGLE_GENERATIVE_AI_API_KEY' },
    { provider: 'mistral', label: 'Mistral', env: 'MISTRAL_API_KEY' },
    { provider: 'groq', label: 'Groq', env: 'GROQ_API_KEY' },
    { provider: 'xai', label: 'xAI', env: 'XAI_API_KEY' },
  ];

  app.get('/api/v1/models/native-providers', async (c) => {
    await initPromise;
    const providers = await Promise.all(
      NATIVE_PROVIDERS.map(async (p) => ({
        ...p,
        hasAuth: (await piClient.getProviderAuthStatus?.(p.provider))?.configured ?? false,
      }))
    );
    return c.json({ providers });
  });

  app.post('/api/v1/models/native-providers/auth', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { provider?: string; apiKey?: string };
    const provider = String(body.provider ?? '').trim();
    const apiKey = String(body.apiKey ?? '').trim();

    if (!provider) {
      return c.json({ error: { code: 'INVALID_PROVIDER', message: 'provider is required' } }, 400);
    }
    if (!apiKey) {
      return c.json({ error: { code: 'INVALID_API_KEY', message: 'apiKey is required' } }, 400);
    }

    const known = NATIVE_PROVIDERS.find((p) => p.provider === provider);
    if (!known) {
      return c.json({ error: { code: 'UNKNOWN_PROVIDER', message: `Unknown provider: ${provider}` } }, 400);
    }

    try {
      await piClient.setProviderApiKey?.(provider, apiKey);
      return c.json({ ok: true, provider });
    } catch (error) {
      return c.json({ error: { code: 'AUTH_STORAGE_ERROR', message: error instanceof Error ? error.message : 'Failed to store API key' } }, 500);
    }
  });
}
