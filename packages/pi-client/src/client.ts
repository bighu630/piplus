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
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { readHistory } from './history';
import { RuntimeRegistry } from './runtime-registry';
import type {
  PiClient,
  PiCreateSessionResult,
  PiHistoryPage,
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

  return null;
}

function sessionFileHasModelChange(sessionManager: SessionManager, provider: string, modelId: string) {
  const entries = sessionManager.getEntries() as SessionEntry[];
  return entries.some((entry) => entry.type === 'model_change' && entry.provider === provider && entry.modelId === modelId);
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
      });
      const locator: PiSessionLocator = {
        piSessionId: session.sessionId,
        sessionFile: session.sessionFile ?? '',
      };
      if (input.model && locator.sessionFile) {
        const sessionManager = SessionManager.open(locator.sessionFile);
        if (!sessionFileHasModelChange(sessionManager, model.provider, model.id)) {
          sessionManager.appendModelChange(model.provider, model.id);
        }
      }
      const active = runtimeRegistry.ensure(session.sessionId, locator, cwd);
      active.prompt = input.prompt;
      active.title = input.title ?? null;
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
        };

        if (!sessionContext.model) {
          options.model = await ensureModel();
          console.log('[pi-client] restoreRuntime fallback default model', {
            sessionId,
            provider: options.model?.provider ?? null,
            id: options.model?.id ?? null,
          });
        } else {
          console.log('[pi-client] restoreRuntime sessionContext model', {
            sessionId,
            provider: sessionContext.model.provider,
            id: sessionContext.model.modelId,
          });
        }

        const { session: agentSession } = await createAgentSession(options);
        const session = runtimeRegistry.ensure(sessionId, locator, runtimeCwd);
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
    async sendMessage(sessionId, content): Promise<PiRunAccepted> {
      const session = getOrCreateSession(sessionId);
      const runId = `run_${crypto.randomUUID().slice(0, 10)}`;

      if (session.agentSession) {
        console.log('[pi-client] sendMessage → agentSession.prompt', { sessionId, content: content.slice(0, 80) });
        await session.agentSession.prompt(content);
        console.log('[pi-client] sendMessage ← agentSession.prompt done', { sessionId });
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
      return { status: 'stopped' as const };
    },
    async closeRuntime(sessionId) {
      const session = runtimeRegistry.get(sessionId);
      session?.agentSession?.dispose();
      runtimeRegistry.delete(sessionId);
    },
    async listAvailableModels() {
      const models = await modelRegistry.getAvailable();
      return models.map((m) => ({
        provider: m.provider,
        id: m.id,
        label: m.name ?? `${m.provider}/${m.id}`,
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

      // 兜底：确保模型切换一定持久化到 session 文件。
      // 按文档 AgentSession.setModel() 会 appendModelChange，但当前集成路径下测试显示
      // 某些情况下 session 文件没有写入 model_change，因此这里做一次镜像校验与补写。
      const sessionManager = SessionManager.open(locator.sessionFile);
      if (!sessionFileHasModelChange(sessionManager, target.provider, target.id)) {
        sessionManager.appendModelChange(target.provider, target.id);
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
      };

      if (!sessionContext.model) {
        options.model = await ensureModel();
        console.log('[pi-client] bindToolRuntime fallback default model', {
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

    async registerTools(_tools: PiToolDef[]) {
      // Stub: tools are registered in-memory only.
      // Real PI SDK adapter will register tools with the PI agent runtime.
    },
  };
}
