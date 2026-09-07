import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionAPI,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { NON_WORKER_IDLE_RUNTIME_TTL_MS } from '../constants';
import { isAskPending } from '../ask-pending';
import type { PiSessionLocator } from '../locator';
import type { PiCreateSessionInput, PiCreateSessionResult, PiToolDef } from '../types';
import type { ClientDeps } from './deps';
import { collectCommands } from './commands';

export function sessionFileHasModelChange(sessionManager: SessionManager, provider: string, modelId: string) {
  const entries = sessionManager.getEntries() as SessionEntry[];
  return entries.some((entry) => entry.type === 'model_change' && entry.provider === provider && entry.modelId === modelId);
}

/**
 * 在扩展工厂中注册 before_agent_start 处理器：向 systemPrompt 追加附加提示文本
 * （如 domain 传入的 ask_question 使用指引）。
 * SDK 链式语义：每个 turn 以 base systemPrompt 为输入，再叠加本段文本，因此每 turn 只追加一次、不会累积。
 */
export function registerAgentStartSystemPrompt(pi: ExtensionAPI, systemPrompt: string): void {
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt ? `${event.systemPrompt}\n\n${systemPrompt}` : systemPrompt,
  }));
}

export async function createSession(
  deps: ClientDeps,
  input: PiCreateSessionInput,
): Promise<PiCreateSessionResult> {
  const available = await deps.modelRegistry.getAvailable();
  const model = input.model
    ? available.find((candidate) => candidate.provider === input.model!.provider && candidate.id === input.model!.id)
    : await deps.ensureModel();
  if (!model) {
    throw new Error('pi_model_not_found');
  }
  const cwd = input.cwd ?? process.cwd();
  const { session } = await createAgentSession({
    cwd,
    sessionManager: SessionManager.create(cwd),
    model,
    modelRuntime: deps.modelRuntime,
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
  const active = deps.runtimeRegistry.ensure(session.sessionId, locator, cwd);
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
}

export async function restoreRuntime(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
  cwd?: string,
): Promise<void> {
  const existing = deps.runtimeRegistry.get(sessionId);
  if (existing?.agentSession) {
    console.log('[pi-client] restoreRuntime skipped — runtime already alive', { sessionId });
    return;
  }
  const runtimeCwd = cwd ?? existing?.cwd ?? process.cwd();
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
      modelRuntime: deps.modelRuntime,
    };

    if (sessionContext.model) {
      const available = await deps.modelRegistry.getAvailable();
      const restored = available.find((m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId);
      if (restored) {
        options.model = restored;
        console.log('[pi-client] restoreRuntime restored session model', {
          sessionId,
          provider: restored.provider,
          id: restored.id,
        });
      } else {
        options.model = await deps.ensureModel();
        console.log('[pi-client] restoreRuntime session model not in registry, fallback default', {
          sessionId,
          provider: options.model?.provider ?? null,
          id: options.model?.id ?? null,
        });
      }
    } else {
      options.model = await deps.ensureModel();
      console.log('[pi-client] restoreRuntime no session model, fallback default', {
        sessionId,
        provider: options.model?.provider ?? null,
        id: options.model?.id ?? null,
      });
    }

    const { session: agentSession } = await createAgentSession(options);
    const session = deps.runtimeRegistry.ensure(sessionId, locator, runtimeCwd);
    session.agentSession = agentSession;
    // 新 run 意味着正常状态：复位上次流式守卫的失败重试计数
    session.closeRetries = 0;

    // Collect slash commands from restored agent session
    try {
      session.commands = collectCommands(agentSession);
    } catch (err) {
      console.warn('[pi-client] restoreRuntime failed to collect commands', { sessionId, error: String(err) });
    }

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

    // Schedule idle cleanup: dispose runtime after 30min of inactivity
    if (session.idleCleanupTimer) clearTimeout(session.idleCleanupTimer);
    session.idleCleanupTimer = setTimeout(() => {
      console.log('[pi-client] restoreRuntime idle cleanup triggered', { sessionId });
      deps.client.closeRuntime(sessionId).catch(() => {});
    }, NON_WORKER_IDLE_RUNTIME_TTL_MS);
  } catch {
    throw new Error('pi_session_runtime_unavailable');
  }
}

export async function ensureRuntime(
  deps: ClientDeps,
  sessionId: string,
  options: {
    locator: PiSessionLocator;
    cwd: string;
    tools: PiToolDef[];
    toolHandler: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>;
    /** 附加系统提示文本（如 ask_question 使用指引），经 before_agent_start 注入。 */
    systemPrompt?: string;
  },
): Promise<void> {
  const { locator, cwd, tools, toolHandler, systemPrompt } = options;
  const existing = deps.runtimeRegistry.get(sessionId);

  if (existing?.agentSession) {
    // Check if tools changed — if so, dispose and recreate
    const toolsChanged = existing.toolDefs?.length !== tools.length ||
      !tools.every((t, i) => t.name === existing.toolDefs?.[i]?.name);
    const handlerChanged = existing.toolHandler !== toolHandler;
    if (toolsChanged || handlerChanged) {
      existing.agentSession.dispose();
      existing.agentSession = undefined;
      console.log('[pi-client] ensureRuntime rebinding — tools changed', { sessionId });
    } else {
      existing.toolDefs = tools;
      existing.toolHandler = toolHandler;
      console.log('[pi-client] ensureRuntime skipped — runtime already alive, tools unchanged', { sessionId });
      // 与 domain 定时器"每次 run 重置"语义对齐：长期活跃的 runtime 从不重建，
      // 若不重置，client 定时器会在 run 中途触发回收，dispose 在途生成。
      if (existing.idleCleanupTimer) clearTimeout(existing.idleCleanupTimer);
      existing.idleCleanupTimer = setTimeout(() => {
        console.log('[pi-client] ensureRuntime idle cleanup triggered', { sessionId });
        deps.client.closeRuntime(sessionId).catch(() => {});
      }, NON_WORKER_IDLE_RUNTIME_TTL_MS);
      // 新 run 意味着正常状态：复位上次流式守卫的失败重试计数
      existing.closeRetries = 0;
      return;
    }
  }

  const runtimeCwd = cwd ?? existing?.cwd ?? process.cwd();
  console.log('[pi-client] ensureRuntime start', { sessionId, locatorFile: locator.sessionFile, cwd: runtimeCwd });

  const sessionDir = dirname(locator.sessionFile);
  const expectedSessionDir = SessionManager.create(runtimeCwd).getSessionDir();
  const isPiSessionPath = sessionDir === expectedSessionDir;
  if (!existsSync(locator.sessionFile) && (!existsSync(sessionDir) || !isPiSessionPath)) {
    throw new Error('pi_session_runtime_unavailable');
  }

  try {
    const sessionManager = SessionManager.open(locator.sessionFile);
    const sessionContext = sessionManager.buildSessionContext();

    // Build resource loader with tool extensions
    const loader = new DefaultResourceLoader({
      cwd: runtimeCwd,
      agentDir: getAgentDir(),
      extensionFactories: [
        (pi) => {
          // ask_question 等附加系统提示：before_agent_start 每 turn 注入一次（链式、不累积）
          if (systemPrompt) {
            registerAgentStartSystemPrompt(pi, systemPrompt);
          }
          for (const toolDef of tools) {
            pi.registerTool({
              name: toolDef.name,
              label: toolDef.name,
              description: toolDef.description,
              parameters: toolDef.parameters as any,
              execute: async (_toolCallId, params) => {
                const result = await toolHandler(toolDef.name, params as Record<string, unknown>, { sessionId });
                // handler 返回 { content, details }（如 ask_question）时直接透传，保留 details
                // 供前端渲染；否则按原逻辑包一层 text 文本内容。
                if (
                  result !== null &&
                  typeof result === 'object' &&
                  !Array.isArray(result) &&
                  'content' in result &&
                  'details' in result
                ) {
                  return result as { content: Array<{ type: 'text'; text: string }>; details: unknown };
                }
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

    const options_create: Parameters<typeof createAgentSession>[0] = {
      cwd: runtimeCwd,
      resourceLoader: loader,
      sessionManager,
      modelRuntime: deps.modelRuntime,
    };

    if (sessionContext.model) {
      const available = await deps.modelRegistry.getAvailable();
      const restored = available.find((m) => m.provider === sessionContext.model!.provider && m.id === sessionContext.model!.modelId);
      options_create.model = restored ?? await deps.ensureModel();
    } else {
      options_create.model = await deps.ensureModel();
    }

    const { session: agentSession } = await createAgentSession(options_create);
    const session = deps.runtimeRegistry.ensure(sessionId, locator, runtimeCwd);
    session.agentSession = agentSession;
    session.toolDefs = tools;
    session.toolHandler = toolHandler;
    // 新 run 意味着正常状态：复位上次流式守卫的失败重试计数
    session.closeRetries = 0;

    // Migrate prompt from piSessionId entry (stored by createSession)
    const piSessionId = locator.piSessionId;
    if (piSessionId && piSessionId !== sessionId && !session.prompt) {
      const createdEntry = deps.runtimeRegistry.get(piSessionId);
      if (createdEntry?.prompt) {
        session.prompt = createdEntry.prompt;
        session.promptSent = createdEntry.promptSent;
        console.log('[pi-client] ensureRuntime migrated prompt from piSessionId', {
          sessionId, piSessionId, promptLen: session.prompt.length,
        });
      }
    }

    // 别名 entry 的唯一用途是把角色 prompt 移交给 domain entry；迁移后即无用，
    // 删除以免 registry 随创建会话数量无限增长。放在成功路径内：ensureRuntime
    // 抛错时别名保留，下次重试仍可迁移（prompt 为空也删——无内容可交接）。
    if (piSessionId && piSessionId !== sessionId) {
      deps.runtimeRegistry.delete(piSessionId);
    }

    // Collect slash commands
    try {
      session.commands = collectCommands(agentSession);
    } catch (err) {
      console.warn('[pi-client] ensureRuntime failed to collect commands', { sessionId, error: String(err) });
    }

    if (agentSession.model) {
      session.model = {
        provider: agentSession.model.provider,
        id: agentSession.model.id,
        label: agentSession.model.name ?? `${agentSession.model.provider}/${agentSession.model.id}`,
      };
    }

    console.log('[pi-client] ensureRuntime done', {
      sessionId,
      provider: session.model?.provider ?? null,
      id: session.model?.id ?? null,
    });

    // Schedule idle cleanup
    if (session.idleCleanupTimer) clearTimeout(session.idleCleanupTimer);
    session.idleCleanupTimer = setTimeout(() => {
      console.log('[pi-client] ensureRuntime idle cleanup triggered', { sessionId });
      deps.client.closeRuntime(sessionId).catch(() => {});
    }, NON_WORKER_IDLE_RUNTIME_TTL_MS);
  } catch {
    throw new Error('pi_session_runtime_unavailable');
  }
}

export async function closeRuntime(deps: ClientDeps, sessionId: string): Promise<void> {
  const session = deps.runtimeRegistry.get(sessionId);
  if (!session) return; // idempotent, already cleaned
  if (session.idleCleanupTimer) { clearTimeout(session.idleCleanupTimer); session.idleCleanupTimer = undefined; }
  // 等待用户回答期间（ask_question pending）绝不回收：用户可在任意时间回答，
  // 即使 runtime 已空闲，pending 的 promise 仍阻塞工具等待回答。
  if (isAskPending(sessionId)) {
    console.log('[pi-client] closeRuntime skipped — waiting for user answer (ask_question)', { sessionId });
    // 延长等待：30s 后重试，仍 pending 则继续跳过
    session.idleCleanupTimer = setTimeout(() => {
      deps.client.closeRuntime(sessionId).catch(() => {});
    }, 30_000);
    return;
  }
  // 绝不 dispose 正在流式生成的 agentSession —— dispose() 会 abort 在途生成。
  // 定时器触发时若 run 仍在进行，跳过本次回收；重试定时器 30s 后再次尝试。
  // 覆盖 worker 立即回收路径的极端时序，避免 worker runtime 泄漏。
  if (session.agentSession?.isStreaming) {
    // 重试计数封顶：provider 连接挂死导致 isStreaming 永不复位时，强制 dispose 兜底，
    // 避免僵尸 runtime + 定时器无限循环。
    // 上界：30min（client 定时器原始触发）+ 40 × 30s ≈ 50min 连续流式的合法长 run
    // 才会被强制回收——正常 run 每次开始都会经 ensureRuntime 刷新定时器并复位计数。
    session.closeRetries = (session.closeRetries ?? 0) + 1;
    if (session.closeRetries < 40) {
      console.log('[pi-client] closeRuntime skipped — agent still streaming', { sessionId, retry: session.closeRetries });
      session.idleCleanupTimer = setTimeout(() => {
        deps.client.closeRuntime(sessionId).catch(() => {});
      }, 30_000);
      return;
    }
    console.warn('[pi-client] closeRuntime force disposing after 40 streaming retries', { sessionId });
  }
  session.agentSession?.dispose();
  session.agentSession = undefined;
  session.closeRetries = 0;
  session.listeners.clear();
  session.toolHandler = undefined;
  session.toolDefs = [];
  session.messages = [];
  // Preserve the registry entry (locator, cwd, model) so that
  // bindToolRuntime() and restoreRuntime() can still find the
  // session file and model metadata on subsequent calls.
}

/** 删除/归档会话时释放 runtime 并删除 registry 条目（含 createSession 的 piSessionId 别名条目）。
 *  注意：不做 isStreaming 守卫——删除项目必须中止在途生成；
 *  孤儿 run 的 doCleanup 对已删除的 DB 行是 0 行更新，安全。 */
export async function disposeSession(deps: ClientDeps, sessionId: string, locator?: PiSessionLocator): Promise<void> {
  const session = deps.runtimeRegistry.get(sessionId);
  if (session) {
    if (session.idleCleanupTimer) { clearTimeout(session.idleCleanupTimer); session.idleCleanupTimer = undefined; }
    try { session.agentSession?.dispose(); } catch { /* ignore */ }
    deps.runtimeRegistry.delete(sessionId);
  }
  // main entry 不存在时也要删别名——"createSession 后从未 run"的会话只有别名条目。
  if (locator?.piSessionId && locator.piSessionId !== sessionId) {
    deps.runtimeRegistry.delete(locator.piSessionId);
  }
}
