import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  AuthStorage,
  ModelRegistry,
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

function decodeCursor(cursor: string | null | undefined) {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function createPiClient(): PiClient {
  let resolvedModel: any;
  (async () => {
    const available = await modelRegistry.getAvailable();
    resolvedModel = available.find((m) => m.provider === 'deepseek' && m.id === 'deepseek-v4-pro') ?? available[0];
  })();

  async function ensureModel(): Promise<any> {
    if (resolvedModel) return resolvedModel;
    const available = await modelRegistry.getAvailable();
    resolvedModel = available.find((m) => m.provider === 'deepseek' && m.id === 'deepseek-v4-pro') ?? available[0];
    return resolvedModel;
  }

  return {
    async createSession(input): Promise<PiCreateSessionResult> {
      const model = await ensureModel();
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
      const active = runtimeRegistry.ensure(session.sessionId, locator, cwd);
      active.prompt = input.prompt;
      active.title = input.title ?? null;
      session.dispose();
      return { sessionId: session.sessionId, locator };
    },
    async restoreRuntime(sessionId, locator, cwd) {
      const runtimeCwd = cwd ?? runtimeRegistry.get(sessionId)?.cwd ?? process.cwd();
      const sessionDir = dirname(locator.sessionFile);
      const expectedSessionDir = SessionManager.create(runtimeCwd).getSessionDir();
      const isPiSessionPath = sessionDir === expectedSessionDir;
      if (!existsSync(locator.sessionFile) && (!existsSync(sessionDir) || !isPiSessionPath)) {
        throw new Error('pi_session_runtime_unavailable');
      }
      try {
        const model = await ensureModel();
        const { session: agentSession } = await createAgentSession({
          cwd: runtimeCwd,
          sessionManager: SessionManager.open(locator.sessionFile),
          model,
        });
        const session = runtimeRegistry.ensure(sessionId, locator, runtimeCwd);
        session.agentSession = agentSession;
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
    async getHistory(sessionId, locator, cursor, limit = 50): Promise<PiHistoryPage> {
      const session = runtimeRegistry.get(sessionId);
      if (session?.messages.length) {
        const offset = decodeCursor(cursor);
        const page = session.messages.slice(offset, offset + limit);
        const nextCursor = offset + page.length < session.messages.length ? String(offset + page.length) : null;
        return {
          messages: page.map((message) => ({
            id: message.id,
            role: message.role,
            text: message.text,
            createdAt: null,
          })),
          nextCursor,
        };
      }
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
      const model = session?.agentSession?.model;
      if (!model) return null;
      return {
        provider: model.provider,
        id: model.id,
        label: model.name ?? `${model.provider}/${model.id}`,
      };
    },

    async setSessionModel(sessionId, locator, modelRef, cwd) {
      await this.restoreRuntime(sessionId, locator, cwd);
      const session = runtimeRegistry.get(sessionId);
      if (!session?.agentSession) {
        throw new Error('pi_session_runtime_unavailable');
      }
      if (session.agentSession.isStreaming) {
        throw new Error('pi_session_busy');
      }

      const available = await modelRegistry.getAvailable();
      const target = available.find((m) => m.provider === modelRef.provider && m.id === modelRef.id);
      if (!target) throw new Error('pi_model_not_found');

      await session.agentSession.setModel(target);
      return {
        provider: target.provider,
        id: target.id,
        label: target.name ?? `${target.provider}/${target.id}`,
      };
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

      const model = await ensureModel();
      const { session: agentSession } = await createAgentSession({
        cwd: session.cwd,
        resourceLoader: loader,
        sessionManager: SessionManager.open(session.locator.sessionFile),
        model,
      });
      session.agentSession = agentSession;
    },

    async registerTools(_tools: PiToolDef[]) {
      // Stub: tools are registered in-memory only.
      // Real PI SDK adapter will register tools with the PI agent runtime.
    },
  };
}
