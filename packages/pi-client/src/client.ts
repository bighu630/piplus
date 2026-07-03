import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { readHistory } from './history';
import { RuntimeRegistry } from './runtime-registry';
import type {
  PiClient,
  PiCreateSessionResult,
  PiHistoryPage,
  PiImageInput,
  PiMessage,
  PiRunAccepted,
  PiSessionStreamEvent,
  PiToolDef,
} from './types';
import type { PiSessionLocator } from './locator';

const runtimeRegistry = new RuntimeRegistry();
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

function getOrCreateSession(sessionId: string) {
  return runtimeRegistry.ensure(sessionId);
}

function mapAgentSessionEvent(
  sessionId: string,
  runId: string,
  event: AgentSessionEvent,
): PiSessionStreamEvent | null {
  if (event.type === 'message_start' && event.message.role === 'assistant') {
    return { type: 'message_start', sessionId, runId };
  }

  if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
    return {
      type: 'text_delta',
      sessionId,
      runId,
      delta: event.assistantMessageEvent.delta,
    };
  }

  if (event.type === 'message_end' && event.message.role === 'assistant') {
    return { type: 'message_end', sessionId, runId };
  }

  if (event.type === 'compaction_start') {
    return { type: 'compaction_start', sessionId, reason: event.reason };
  }

  if (event.type === 'compaction_end') {
    return {
      type: 'compaction_end',
      sessionId,
      reason: event.reason,
      aborted: event.aborted,
      errorMessage: event.errorMessage,
    };
  }

  if (event.type === 'auto_retry_end' && event.success === false) {
    return { type: 'error', sessionId, runId: `auto_retry_${crypto.randomUUID().slice(0, 10)}`, error: event.finalError ?? 'auto_retry_failed' };
  }

  return null;
}

function sessionFileHasModelChange(sessionManager: SessionManager, provider: string, modelId: string) {
  const entries = sessionManager.getEntries() as SessionEntry[];
  return entries.some((entry) => entry.type === 'model_change' && entry.provider === provider && entry.modelId === modelId);
}

function normalizeImages(images: PiImageInput[] | undefined) {
  return images?.map((image) => ({
    type: 'image' as const,
    data: image.dataBase64,
    mimeType: image.mimeType ?? image.mediaType ?? 'image/png',
  }));
}

export function createPiClient(): PiClient {
  let resolvedModel: any;
  (async () => {
    const available = await modelRegistry.getAvailable();
    resolvedModel = available[0];
  })();

  async function ensureModel(): Promise<any> {
    if (resolvedModel) return resolvedModel;
    const available = await modelRegistry.getAvailable();
    resolvedModel = available[0];
    return resolvedModel;
  }

  return {
    async createSession(input): Promise<PiCreateSessionResult> {
      const available = await modelRegistry.getAvailable();
      const model = input.model
        ? available.find((candidate) => candidate.provider === input.model!.provider && candidate.id === input.model!.id)
        : await ensureModel();
      if (!model) {
        throw new Error('pi_model_not_found');
      }
      const cwd = input.cwd ?? process.cwd();
      const { session } = await createAgentSession({
        cwd,
        sessionManager: SessionManager.create(cwd),
        model,
        modelRegistry,
      });
      const locator: PiSessionLocator = {
        piSessionId: session.sessionId,
        sessionFile: session.sessionFile ?? '',
      };
      // 确保 session 文件立即落盘。SessionManager._persist 在没有 assistant 消息时
      // 不会刷新到磁盘，导致后续 appendModelChange 仅存于内存。提前创建文件让
      // SessionManager.open 读取后设置 flushed=true，appendModelChange 即可立即持久化。
      if (locator.sessionFile && !existsSync(locator.sessionFile)) {
        const sessionDir = dirname(locator.sessionFile);
        if (!existsSync(sessionDir)) {
          mkdirSync(sessionDir, { recursive: true });
        }
        writeFileSync(locator.sessionFile, JSON.stringify({
          type: 'session',
          version: 3,
          id: session.sessionId,
          timestamp: new Date().toISOString(),
          cwd,
        }) + '\n');
        console.log('[pi-client] createSession → seeded session file', { sessionFile: locator.sessionFile });
      }
      if (input.model && locator.sessionFile) {
        const sessionManager = SessionManager.open(locator.sessionFile);
        if (!sessionFileHasModelChange(sessionManager, model.provider, model.id)) {
          sessionManager.appendModelChange(model.provider, model.id);
        }
      }
      const active = runtimeRegistry.ensure(session.sessionId, locator, cwd);
      active.prompt = input.prompt;
      active.title = input.title ?? null;
      console.log('[pi-client] createSession stored prompt', { piSessionId: session.sessionId, promptLen: active.prompt.length });
      active.model = {
        provider: model.provider,
        id: model.id,
        label: model.name ?? `${model.provider}/${model.id}`,
      };
      session.dispose();
      return { sessionId: session.sessionId, locator, model: active.model };
    },
    async restoreRuntime(sessionId, locator, cwd) {
      const runtimeCwd = cwd ?? runtimeRegistry.get(sessionId)?.cwd ?? process.cwd();
      console.log('[pi-client] restoreRuntime start', { sessionId, locatorFile: locator.sessionFile, cwd: runtimeCwd });
      const sessionDir = dirname(locator.sessionFile);
      const expectedSessionDir = SessionManager.create(runtimeCwd).getSessionDir();
      const isPiSessionPath = sessionDir === expectedSessionDir;
      if (!existsSync(locator.sessionFile) && (!existsSync(sessionDir) || !isPiSessionPath)) {
        throw new Error('pi_session_runtime_unavailable');
      }
      try {
        const sessionManager = SessionManager.open(locator.sessionFile);
        const sessionContext = sessionManager.buildSessionContext();

        const options: Parameters<typeof createAgentSession>[0] = {
          cwd: runtimeCwd,
          sessionManager,
          modelRegistry,
        };

        if (sessionContext.model) {
          const available = await modelRegistry.getAvailable();
          const restored = available.find((m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId);
          if (restored) {
            options.model = restored;
            console.log('[pi-client] restoreRuntime restored session model', {
              sessionId,
              provider: restored.provider,
              id: restored.id,
            });
          } else {
            options.model = await ensureModel();
            console.log('[pi-client] restoreRuntime session model not in registry, fallback default', {
              sessionId,
              provider: options.model?.provider ?? null,
              id: options.model?.id ?? null,
            });
          }
        } else {
          options.model = await ensureModel();
          console.log('[pi-client] restoreRuntime no session model, fallback default', {
            sessionId,
            provider: options.model?.provider ?? null,
            id: options.model?.id ?? null,
          });
        }

        const { session: agentSession } = await createAgentSession(options);
        const session = runtimeRegistry.ensure(sessionId, locator, runtimeCwd);
        // 把 createSession 用 piSessionId 存的 prompt 迁移过来
        const piSessionId = locator.piSessionId;
        if (piSessionId && piSessionId !== sessionId) {
          const createdEntry = runtimeRegistry.get(piSessionId);
          if (createdEntry?.prompt && !session.prompt) {
            session.prompt = createdEntry.prompt;
            session.promptSent = createdEntry.promptSent;
            console.log('[pi-client] restoreRuntime transferred prompt', { sessionId, piSessionId, promptLen: session.prompt.length });
          }
        }
        session.agentSession = agentSession;

        if (agentSession.model) {
          session.model = {
            provider: agentSession.model.provider,
            id: agentSession.model.id,
            label: agentSession.model.name ?? `${agentSession.model.provider}/${agentSession.model.id}`,
          };
        }
        console.log('[pi-client] restoreRuntime done', {
          sessionId,
          provider: session.model?.provider ?? null,
          id: session.model?.id ?? null,
        });
      } catch {
        throw new Error('pi_session_runtime_unavailable');
      }
    },
    async subscribeSession(sessionId, listener) {
      const session = runtimeRegistry.ensure(sessionId);
      session.listeners.add(listener);

      let runtimeUnsubscribe: (() => void) | undefined;
      if (session.agentSession) {
        const runId = `runtime_${crypto.randomUUID().slice(0, 10)}`;
        runtimeUnsubscribe = session.agentSession.subscribe((event) => {
          const mapped = mapAgentSessionEvent(sessionId, runId, event);
          if (!mapped) return;
          void listener(mapped);
        });
      }

      return () => {
        runtimeUnsubscribe?.();
        session.listeners.delete(listener);
      };
    },
    async getHistory(_sessionId, locator, cursor, limit = 50): Promise<PiHistoryPage> {
      return readHistory(locator, cursor, limit);
    },
    async sendMessage(sessionId, content, options): Promise<PiRunAccepted> {
      const session = getOrCreateSession(sessionId);
      const runId = `run_${crypto.randomUUID().slice(0, 10)}`;

      if (session.agentSession) {
        if (session.prompt && !session.promptSent) {
          if (content || options?.images?.length) {
            // 首次对话且 content 非空：合并角色提示词和用户消息为 1 轮
            const merged = `${session.prompt}\n\n请尊重用户的语言习惯，现在用户说：\n\n${content}`;
            console.log('[pi-client] sendMessage → merged prompt + user message', { sessionId, promptLen: session.prompt.length, contentLen: content.length, imageCount: options?.images?.length ?? 0 });
            try {
              const images = normalizeImages(options?.images);
              if (images?.length) {
                await session.agentSession.prompt(merged, { images });
              } else {
                await session.agentSession.prompt(merged);
              }
            } catch (err) {
              const errorEvent: PiSessionStreamEvent = { type: 'error', sessionId, runId, error: err instanceof Error ? err.message : String(err) };
              for (const listener of session.listeners) {
                await listener(errorEvent);
              }
              throw err;
            }
            session.promptSent = true;
            console.log('[pi-client] sendMessage ← merged prompt done', { sessionId });
          } else {
            // spawn_session 场景：content 为空，仅注入角色 prompt（1 轮）
            console.log('[pi-client] sendMessage → injecting role prompt (no user message)', { sessionId, promptLen: session.prompt.length });
            try {
              await session.agentSession.prompt(session.prompt);
            } catch (err) {
              const errorEvent: PiSessionStreamEvent = { type: 'error', sessionId, runId, error: err instanceof Error ? err.message : String(err) };
              for (const listener of session.listeners) {
                await listener(errorEvent);
              }
              throw err;
            }
            session.promptSent = true;
            console.log('[pi-client] sendMessage ← role prompt done', { sessionId });
          }
        } else if (content || options?.images?.length) {
          // 后续消息：promptSent 已为 true，仅发送用户消息
          console.log('[pi-client] sendMessage → agentSession.prompt', {
            sessionId,
            content: content.slice(0, 80),
            imageCount: options?.images?.length ?? 0,
          });
          try {
            const images = normalizeImages(options?.images);
            if (images?.length) {
              await session.agentSession.prompt(content, { images });
            } else {
              await session.agentSession.prompt(content);
            }
          } catch (err) {
            const errorEvent: PiSessionStreamEvent = { type: 'error', sessionId, runId, error: err instanceof Error ? err.message : String(err) };
            for (const listener of session.listeners) {
              await listener(errorEvent);
            }
            throw err;
          }
          console.log('[pi-client] sendMessage ← agentSession.prompt done', { sessionId });
        } else {
          console.log('[pi-client] sendMessage → content is empty, nothing to send', { sessionId });
        }
        return { sessionId, runId };
      }

      const userMessage: PiMessage = { id: `pi_msg_${crypto.randomUUID().slice(0, 10)}`, role: 'user', text: content };
      const assistantMessage: PiMessage = { id: `pi_msg_${crypto.randomUUID().slice(0, 10)}`, role: 'assistant', text: content };
      session.stopped = false;
      session.messages.push(userMessage, assistantMessage);

      const manager = SessionManager.open(session.locator.sessionFile);
      manager.appendMessage({
        role: 'user',
        content,
        timestamp: Date.now(),
      });
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: content }],
        api: 'stub',
        provider: 'stub',
        model: 'stub',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      });

      for (const listener of session.listeners) {
        await listener({ type: 'message_start', sessionId, runId, messageId: assistantMessage.id });
        await listener({ type: 'text_delta', sessionId, runId, messageId: assistantMessage.id, delta: content });
        await listener({ type: 'message_end', sessionId, runId, messageId: assistantMessage.id });
      }

      return { sessionId, runId };
    },
    async stopSession(sessionId) {
      const session = getOrCreateSession(sessionId);
      session.stopped = true;
      // Fire abort in background — AgentSession.abort() waits for agent to become idle,
      // which can block indefinitely during LLM generation. The caller (API route) needs
      // to return 202 immediately and must not wait for the agent to wind down.
      session.agentSession?.abort().catch(() => {});
      return { status: 'stopped' as const };
    },
    async closeRuntime(sessionId) {
      const session = runtimeRegistry.get(sessionId);
      if (!session) return; // idempotent, already cleaned
      session.agentSession?.dispose();
      session.agentSession = undefined;
      session.listeners.clear();
      session.toolHandler = undefined;
      session.toolDefs = [];
      session.messages = [];
      session.prompt = '';
      session.promptSent = false;
      // Preserve the registry entry (locator, cwd, model) so that
      // bindToolRuntime() and restoreRuntime() can still find the
      // session file and model metadata on subsequent calls.
    },

    /**
     * Close all idle runtimes so they pick up new settings on next restore.
     * Running sessions are left untouched.
     */
    async reloadIdleRuntimes(): Promise<number> {
      return runtimeRegistry.closeIdle((session) => {
        try {
          if (session.agentSession) {
            session.agentSession.dispose();
          }
        } catch {
          // Ignore disposal errors
        }
        if (session.locator.piSessionId) {
          runtimeRegistry.delete(session.locator.piSessionId);
        }
      });
    },
    async listAvailableModels() {
      const models = await modelRegistry.getAvailable();
      return models.map((m) => ({
        provider: m.provider,
        id: m.id,
        label: m.name ?? m.id,
      }));
    },

    async getCurrentModel(sessionId) {
      const session = runtimeRegistry.get(sessionId);
      // 优先返回 registry 中缓存的模型（用户手动设置的），agentSession.model 可能被 bindToolRuntime 覆盖
      return session?.model ?? null;
    },

    async setSessionModel(sessionId, locator, modelRef, cwd) {
      let session = runtimeRegistry.ensure(sessionId, locator, cwd);
      console.log('[pi-client] setSessionModel start', {
        sessionId,
        locatorFile: locator.sessionFile,
        provider: modelRef.provider,
        id: modelRef.id,
        cwd: cwd ?? session.cwd,
      });

      const available = await modelRegistry.getAvailable();
      const target = available.find((m) => m.provider === modelRef.provider && m.id === modelRef.id);
      if (!target) throw new Error('pi_model_not_found');

      if (!session.agentSession) {
        await this.restoreRuntime(sessionId, locator, cwd);
        session = runtimeRegistry.ensure(sessionId, locator, cwd);
      }

      if (!session.agentSession) {
        throw new Error('pi_session_runtime_unavailable');
      }
      if (session.agentSession.isStreaming) {
        throw new Error('pi_session_busy');
      }

      await session.agentSession.setModel(target);

      // 兜底：使用 agent 自身的 sessionManager 做镜像校验与补写，
      // 避免 SessionManager.open 创建新实例导致 model_change 无法立即落盘。
      const agsm = session.agentSession.sessionManager;
      if (!sessionFileHasModelChange(agsm, target.provider, target.id)) {
        agsm.appendModelChange(target.provider, target.id);
      }

      session.model = {
        provider: target.provider,
        id: target.id,
        label: target.name ?? `${target.provider}/${target.id}`,
      };

      console.log('[pi-client] setSessionModel done', {
        sessionId,
        provider: session.model.provider,
        id: session.model.id,
      });

      return session.model;
    },

    async bindToolRuntime(sessionId, tools, handler, cwd) {
      const session = runtimeRegistry.ensure(sessionId, undefined, cwd);
      session.toolDefs = tools;
      session.toolHandler = handler;

      if (session.agentSession) {
        session.agentSession.dispose();
      }

      const loader = new DefaultResourceLoader({
        cwd: session.cwd,
        agentDir: getAgentDir(),
        extensionFactories: [
          (pi) => {
            for (const toolDef of tools) {
              pi.registerTool({
                name: toolDef.name,
                label: toolDef.name,
                description: toolDef.description,
                parameters: toolDef.parameters as any,
                execute: async (_toolCallId, params) => {
                  const result = await handler(toolDef.name, params as Record<string, unknown>, { sessionId });
                  return {
                    content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }],
                    details: {},
                  };
                },
              });
            }
          },
        ],
      });
      await loader.reload();

      const sessionManager = SessionManager.open(session.locator.sessionFile);
      const sessionContext = sessionManager.buildSessionContext();
      console.log('[pi-client] bindToolRuntime start', {
        sessionId,
        locatorFile: session.locator.sessionFile,
        cwd: session.cwd,
        sessionContextModelProvider: sessionContext.model?.provider ?? null,
        sessionContextModelId: sessionContext.model?.modelId ?? null,
        registryModelProvider: session.model?.provider ?? null,
        registryModelId: session.model?.id ?? null,
      });
      const options: Parameters<typeof createAgentSession>[0] = {
        cwd: session.cwd,
        resourceLoader: loader,
        sessionManager,
        modelRegistry,
      };

      if (sessionContext.model) {
        const available = await modelRegistry.getAvailable();
        const restored = available.find((m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId);
        if (restored) {
          options.model = restored;
          console.log('[pi-client] bindToolRuntime restored session model', {
            sessionId,
            provider: restored.provider,
            id: restored.id,
          });
        } else {
          options.model = await ensureModel();
          console.log('[pi-client] bindToolRuntime session model not in registry, fallback default', {
            sessionId,
            provider: options.model?.provider ?? null,
            id: options.model?.id ?? null,
          });
        }
      } else if (session.model) {
        const available = await modelRegistry.getAvailable();
        const cached = available.find(
          (candidate: any) => candidate.provider === session.model!.provider && candidate.id === session.model!.id,
        );
        if (cached) {
          options.model = cached;
          console.log('[pi-client] bindToolRuntime using cached registry model', {
            sessionId,
            provider: cached.provider,
            id: cached.id,
          });
        } else {
          options.model = await ensureModel();
          console.log('[pi-client] bindToolRuntime cached model not found in registry, fallback default', {
            sessionId,
            provider: options.model?.provider ?? null,
            id: options.model?.id ?? null,
          });
        }
      } else {
        options.model = await ensureModel();
        console.log('[pi-client] bindToolRuntime no cached model, fallback default', {
          sessionId,
          provider: options.model?.provider ?? null,
          id: options.model?.id ?? null,
        });
      }

      const { session: agentSession } = await createAgentSession(options);
      session.agentSession = agentSession;
      if (agentSession.model) {
        session.model = {
          provider: agentSession.model.provider,
          id: agentSession.model.id,
          label: agentSession.model.name ?? `${agentSession.model.provider}/${agentSession.model.id}`,
        };
      }
      console.log('[pi-client] bindToolRuntime done', {
        sessionId,
        provider: session.model?.provider ?? null,
        id: session.model?.id ?? null,
      });
    },

    async getContextUsage(sessionId, locator) {
      const session = runtimeRegistry.get(sessionId);

      // If AgentSession is alive, use its getContextUsage() for accurate data
      if (session?.agentSession) {
        const usage = session.agentSession.getContextUsage();
        if (usage) return usage;
      }

      // Fallback: estimate from session file
      try {
        const { estimateTokens } = await import('@earendil-works/pi-coding-agent');

        const sessionManager = SessionManager.open(locator.sessionFile);
        const ctx = sessionManager.buildSessionContext();

        // Estimate from all messages using chars/4 heuristic
        const tokens = ctx.messages.reduce((sum, msg) => sum + estimateTokens(msg), 0);

        // Try to find model's context window
        let contextWindow = 128000;
        if (ctx.model) {
          try {
            const available = await modelRegistry.getAvailable();
            const matched = available.find(
              (m: any) => m.provider === ctx.model!.provider && m.id === ctx.model!.modelId,
            );
            if (matched?.contextWindow) {
              contextWindow = matched.contextWindow;
            }
          } catch { /* keep default */ }
        }

        return {
          tokens,
          contextWindow,
          percent: Math.min(100, Math.round((tokens / contextWindow) * 100)),
        };
      } catch {
        return null;
      }
    },

    async compactSession(sessionId, locator, cwd) {
      const session = runtimeRegistry.ensure(sessionId, locator, cwd);

      if (!session.agentSession) {
        await this.restoreRuntime(sessionId, locator, cwd);
      }

      if (!session.agentSession) {
        throw new Error('pi_session_runtime_unavailable');
      }

      if (session.agentSession.isStreaming) {
        throw new Error('pi_session_busy');
      }

      await session.agentSession.compact();
    },

    async registerTools(_tools: PiToolDef[]) {
      // Stub: tools are registered in-memory only.
      // Real PI SDK adapter will register tools with the PI agent runtime.
    },

    async registerProvider(providerName, config) {
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
      modelRegistry.registerProvider(providerName, {
        api: config.api as any,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        authHeader: config.authHeader,
        headers: config.headers,
        models,
      } as any);
    },

    async setProviderApiKey(provider, apiKey) {
      authStorage.set(provider, { type: 'api_key', key: apiKey });
    },

    async removeProviderApiKey(provider) {
      authStorage.remove(provider);
    },

    async getProviderAuthStatus(provider) {
      return authStorage.getAuthStatus(provider);
    },
  };
}
