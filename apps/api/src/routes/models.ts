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

function getModelsFilePath() {
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
  return input.replace(/^\s*\/\/.*$/gm, '');
}

async function readModelsConfig(): Promise<StoredModelsFile> {
  try {
    const raw = await readFile(getModelsFilePath(), 'utf-8');
    const parsed = JSON.parse(stripJsonComments(raw)) as Partial<StoredModelsFile>;
    return { providers: parsed.providers ?? {} };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { providers: {} };
    }
    throw error;
  }
}

async function writeModelsConfig(content: StoredModelsFile) {
  const modelsFilePath = getModelsFilePath();
  await mkdir(join(process.env.HOME || homedir(), '.pi', 'agent'), { recursive: true });
  await writeFile(modelsFilePath, JSON.stringify(content, null, 2) + '\n', 'utf-8');
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

export function registerModelRoutes(app: Hono) {
  const piClient = createPiClient();

  app.get('/api/v1/models/status', async (c) => {
    const models = await piClient.listAvailableModels();
    return c.json({ ok: models.length > 0, count: models.length, models });
  });

  app.get('/api/v1/models', async (c) => {
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

    const config = await readModelsConfig();
    if (config.providers[validated.providerKey]) {
      return c.json({ error: { code: 'PROVIDER_EXISTS', message: 'Provider already exists' } }, 409);
    }

    const providerConfig: Record<string, unknown> = {
      api: body.api?.trim() || 'openai-completions',
      baseURL: validated.baseUrl,
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

      if (model.reasoning) {
        modelEntry.reasoning = true;
      }

      if (model.contextWindow) {
        modelEntry.contextWindow = Number(model.contextWindow);
      }

      if (model.maxTokens) {
        modelEntry.maxTokens = Number(model.maxTokens);
      }

      if (model.cost) {
        const cost: Record<string, number> = {};
        if (model.cost.input !== undefined) cost.input = Number(model.cost.input);
        if (model.cost.output !== undefined) cost.output = Number(model.cost.output);
        if (model.cost.cacheRead !== undefined) cost.cacheRead = Number(model.cost.cacheRead);
        if (model.cost.cacheWrite !== undefined) cost.cacheWrite = Number(model.cost.cacheWrite);
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

    config.providers[validated.providerKey] = providerConfig;

    await writeModelsConfig(config);
    const refreshed = await piClient.listAvailableModels();
    const providerModels = refreshed.filter((model) => model.provider === validated.providerKey);
    return c.json({ ok: true, providerKey: validated.providerKey, models: providerModels });
  });
}
