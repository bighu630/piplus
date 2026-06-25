import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Write only piplus-managed providers to the separate piplus-models.json */
async function writePiplusModelsConfig(content: StoredModelsFile) {
  const filePath = getPiplusModelsFilePath();
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
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
  const apiKey = String(body.apiKey ?? '');
  const authHeader = Boolean(body.authHeader);

  if (!providerKey) {
    return { error: { code: 'INVALID_PROVIDER_KEY', message: 'providerKey is required' }, status: 400 as const };
  }
  if (!baseUrl) {
    return { error: { code: 'INVALID_BASE_URL', message: 'baseUrl is required' }, status: 400 as const };
  }

  return { providerKey, baseUrl, apiKey, authHeader };
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
          cost: m.cost as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
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

export function registerModelRoutes(app: Hono) {
  const piClient = createPiClient();

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

    const models = Array.isArray(body.models) ? body.models : [];
    if (models.length === 0) {
      return c.json({ error: { code: 'INVALID_MODELS', message: 'At least one model is required' } }, 400);
    }

    const invalidModel = models.find((model) => !String(model.id ?? '').trim());
    if (invalidModel) {
      return c.json({ error: { code: 'INVALID_MODEL_ID', message: 'Each model id is required' } }, 400);
    }

    // Check both piplus and pi's models.json for duplicate provider keys
    if (await isProviderKeyTaken(validated.providerKey)) {
      return c.json({ error: { code: 'PROVIDER_EXISTS', message: 'Provider already exists' } }, 409);
    }

    // Build the provider config (same structure as pi's models.json expects)
    const providerConfig: Record<string, unknown> = {
      api: body.api?.trim() || 'openai-completions',
      baseUrl: validated.baseUrl,
      apiKey: validated.apiKey,
      authHeader: validated.authHeader,
    };

    if (body.headers && Object.keys(body.headers).length > 0) {
      providerConfig.headers = body.headers;
    }

    if (body.compat && Object.keys(body.compat).length > 0) {
      providerConfig.compat = body.compat;
    }

    providerConfig.models = models.map((model) => {
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

    // Register with Pi's model registry FIRST (may throw on invalid config).
    // If registration succeeds, models are immediately available for sessions.
    if (!piClient.registerProvider) {
      return c.json({ error: { code: 'REGISTRATION_FAILED', message: 'Provider registration is not available' } }, 500);
    }
    await piClient.registerProvider(validated.providerKey, {
      api: body.api?.trim() || 'openai-completions',
      baseUrl: validated.baseUrl,
      apiKey: validated.apiKey,
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
        cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: model.contextWindow ? Number(model.contextWindow) : 128000,
        maxTokens: model.maxTokens ? Number(model.maxTokens) : 16384,
        compat: model.compat as Record<string, unknown> | undefined,
      })),
    });

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
}
