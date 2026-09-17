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
import { NON_WORKER_IDLE_RUNTIME_TTL_MS, resolveCloseRuntimeRetryIntervalMs, resolveForcedReclaimNoProgressMs } from '../constants';
import { isAskPending } from '../ask-pending';
import { notifyForcedRuntimeDispose } from '../runtime-lifecycle-hooks';
import { isSessionRuntimePinned } from '../runtime-pins';
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
    // 新 run 意味着正常状态：复位上次流式守卫的失败重试计数与无进展观察窗口
    session.closeRetries = 0;
    session.streamingSince = undefined;

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
      // 新 run 意味着正常状态：复位上次流式守卫的失败重试计数与无进展观察窗口
      existing.closeRetries = 0;
      existing.streamingSince = undefined;
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
    // 新 run 意味着正常状态：复位上次流式守卫的失败重试计数与无进展观察窗口
    session.closeRetries = 0;
    session.streamingSince = undefined;

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

export type StreamingReclaimDecision = {
  lastProgressAt: number;
  noProgressMs: number;
  shouldForceDispose: boolean;
};

/**
 * 流式 runtime 是否达到卡死兜底强杀阈值（纯函数，便于单测）。
 * 判据是「连续无进展时长」而不是重试次数：进度基准 = 最近一次成功 mapped 的
 * stream 事件时间（lastStreamEventAt，工具活动等 activity 事件同样计入），
 * 窗口内从未有事件时以观察窗口起点（streamingSince）为基准；
 * 距现在超过阈值才强杀——正常长 run（持续有事件）永远不会被强杀。
 */
export function decideStreamingReclaim(input: {
  now: number;
  streamingSince: number;
  lastStreamEventAt?: number;
  noProgressThresholdMs: number;
}): StreamingReclaimDecision {
  const lastProgressAt = input.lastStreamEventAt ?? input.streamingSince;
  const noProgressMs = Math.max(0, input.now - lastProgressAt);
  return {
    lastProgressAt,
    noProgressMs,
    shouldForceDispose: noProgressMs >= input.noProgressThresholdMs,
  };
}

export async function closeRuntime(deps: ClientDeps, sessionId: string): Promise<void> {
  const session = deps.runtimeRegistry.get(sessionId);
  if (!session) return; // idempotent, already cleaned
  if (session.idleCleanupTimer) { clearTimeout(session.idleCleanupTimer); session.idleCleanupTimer = undefined; }
  // 平台级合法长等待（父会话等待子会话 writeback / 跨项目等待）期间绝不做任何回收：
  // 这类等待可能长时间无 stream 事件（甚至 isStreaming 持续为 true），
  // 但 dispose 会 abort 在途 turn，导致子会话 writeback 结果永远进不了父会话上下文。
  // pin 由 domain 等待循环在进入前设置、finally 解除；期间不累计尝试、不强杀。
  if (isSessionRuntimePinned(sessionId)) {
    console.log('[pi-client] closeRuntime skipped — session pinned by platform long wait', { sessionId });
    // 豁免时长不得计入无进展窗口：清空窗口与进度基准，下个 tick（unpin 之后）重新起算。
    // 否则「pinned 时长 > 阈值」时解除 pin 的首个 tick 会把整段豁免时长当成无进展，
    // 立刻强杀——那正是本机制要避免的事故（pin 的生命周期取舍见
    // docs/session-runtime-reclamation.md「0.1 pin 生命周期无界」）。
    session.streamingSince = undefined;
    session.lastStreamEventAt = undefined;
    session.idleCleanupTimer = setTimeout(() => {
      deps.client.closeRuntime(sessionId).catch(() => {});
    }, resolveCloseRuntimeRetryIntervalMs());
    return;
  }
  // 等待用户回答期间（ask_question pending）绝不回收：用户可在任意时间回答，
  // 即使 runtime 已空闲，pending 的 promise 仍阻塞工具等待回答。
  if (isAskPending(sessionId)) {
    console.log('[pi-client] closeRuntime skipped — waiting for user answer (ask_question)', { sessionId });
    // 同 pin 分支：豁免时长（用户可能几小时后才回答）不得计入无进展窗口，
    // 解除豁免后从新窗口起算，不把等待时长当成 agent 卡死证据。
    session.streamingSince = undefined;
    session.lastStreamEventAt = undefined;
    // 延长等待：按重试间隔重新检查，仍 pending 则继续跳过
    session.idleCleanupTimer = setTimeout(() => {
      deps.client.closeRuntime(sessionId).catch(() => {});
    }, resolveCloseRuntimeRetryIntervalMs());
    return;
  }
  // 绝不 dispose 正在流式生成的 agentSession —— dispose() 会 abort 在途生成。
  // 定时器触发时若 run 仍在进行，按「连续无进展时长」判断：收到任何 mapped
  // stream 事件（含 tool_execution_start 映射的 activity）都算进展，有进展就继续
  // 跳过；只有 provider 挂死导致窗口内连续 noProgress 达阈值才强杀兜底，
  // 避免僵尸 runtime + 定时器无限循环，同时不再误杀合法长 run（与重试次数无关）。
  if (session.agentSession?.isStreaming) {
    const now = Date.now();
    if (session.streamingSince === undefined) {
      // 新观察窗口：丢弃上个窗口的陈旧进展时间，从发现流式的此刻重新计时
      session.streamingSince = now;
      session.lastStreamEventAt = undefined;
    }
    const decision = decideStreamingReclaim({
      now,
      streamingSince: session.streamingSince,
      lastStreamEventAt: session.lastStreamEventAt,
      noProgressThresholdMs: resolveForcedReclaimNoProgressMs(),
    });
    if (decision.shouldForceDispose) {
      const attempts = (session.closeRetries ?? 0) + 1;
      console.warn('[pi-client] closeRuntime force disposing after no stream progress', {
        sessionId,
        attempts,
        noProgressMs: decision.noProgressMs,
      });
      session.agentSession?.dispose();
      session.agentSession = undefined;
      // 复位观察窗口与尝试计数
      session.streamingSince = undefined;
      session.closeRetries = 0;
      // 通知上层（domain）做善后；handler 错误由 notify 内部隔离，不阻塞回收
      void notifyForcedRuntimeDispose({
        sessionId,
        disposedAt: Date.now(),
        attempts,
        noProgressMs: decision.noProgressMs,
      });
      // 落到下方通用清理路径
    } else {
      session.closeRetries = (session.closeRetries ?? 0) + 1;
      console.log('[pi-client] closeRuntime skipped — agent still streaming', {
        sessionId,
        attempts: session.closeRetries,
        noProgressMs: decision.noProgressMs,
        lastStreamEventAt: session.lastStreamEventAt,
      });
      session.idleCleanupTimer = setTimeout(() => {
        deps.client.closeRuntime(sessionId).catch(() => {});
      }, resolveCloseRuntimeRetryIntervalMs());
      return;
    }
  }
  session.agentSession?.dispose();
  session.agentSession = undefined;
  session.closeRetries = 0;
  session.streamingSince = undefined;
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
