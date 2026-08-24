import type { ClientDeps } from './deps';

/**
 * Close all idle runtimes so they pick up new settings on next restore.
 * Running sessions are left untouched.
 */
export async function reloadIdleRuntimes(deps: ClientDeps): Promise<number> {
  return deps.runtimeRegistry.closeIdle((session) => {
    try {
      if (session.agentSession) {
        session.agentSession.dispose();
      }
    } catch {
      // Ignore disposal errors
    }
    // dispose 后必须清空全部状态：ensureRuntime 以 agentSession 真值判断 runtime
    // 存活，残留引用会让后续 run 对已 dispose 的 session 调 prompt() → 每次都失败。
    session.agentSession = undefined;
    session.closeRetries = 0;
    if (session.idleCleanupTimer) { clearTimeout(session.idleCleanupTimer); session.idleCleanupTimer = undefined; }
    session.listeners.clear();
    session.toolHandler = undefined;
    session.toolDefs = [];
    session.messages = [];
    if (session.locator.piSessionId) {
      deps.runtimeRegistry.delete(session.locator.piSessionId);
    }
  });
}

export async function registerProvider(
  deps: ClientDeps,
  providerName: string,
  config: {
    api: string;
    baseUrl: string;
    apiKey: string;
    authHeader?: boolean;
    headers?: Record<string, string>;
    compat?: Record<string, unknown>;
    models: Array<{
      id: string;
      name?: string;
      api?: string;
      baseUrl?: string;
      reasoning?: boolean;
      thinkingLevelMap?: Record<string, string | null>;
      input?: string[];
      cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
      contextWindow?: number;
      maxTokens?: number;
      headers?: Record<string, string>;
      compat?: Record<string, unknown>;
    }>;
  },
): Promise<void> {
  // Normalize the loosely-typed PiClient config to strict ProviderConfigInput
  const models = (config.models ?? []).map((m) => ({
    id: m.id,
    name: m.name ?? m.id,
    api: m.api as any,
    baseUrl: m.baseUrl,
    reasoning: m.reasoning ?? false,
    thinkingLevelMap: m.thinkingLevelMap as any,
    input: m.input?.length ? (m.input as any) : ['text'],
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cacheRead ?? 0,
      cacheWrite: m.cost?.cacheWrite ?? 0,
    },
    contextWindow: m.contextWindow ?? 128000,
    maxTokens: m.maxTokens ?? 16384,
    headers: m.headers,
    compat: m.compat as any,
  }));
  deps.modelRuntime.registerProvider(providerName, {
    api: config.api as any,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    authHeader: config.authHeader,
    headers: config.headers,
    models,
  } as any);
}

export async function setProviderApiKey(deps: ClientDeps, provider: string, apiKey: string): Promise<void> {
  await deps.modelRuntime.setRuntimeApiKey(provider, apiKey);
}

export async function removeProviderApiKey(deps: ClientDeps, provider: string): Promise<void> {
  await deps.modelRuntime.removeRuntimeApiKey(provider);
}

export async function getProviderAuthStatus(deps: ClientDeps, provider: string) {
  return deps.modelRuntime.getProviderAuthStatus(provider);
}
