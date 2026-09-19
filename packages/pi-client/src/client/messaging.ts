import { SessionManager } from '@earendil-works/pi-coding-agent';
import { readHistory } from '../history';
import type { PiSessionLocator } from '../locator';
import type {
  PiHistoryPage,
  PiImageInput,
  PiMessage,
  PiRunAccepted,
  PiSessionStreamEvent,
  PiSteerResult,
} from '../types';
import type { ClientDeps } from './deps';
import { mapAgentSessionEvent } from './event-mapping';

function getOrCreateSession(deps: ClientDeps, sessionId: string) {
  return deps.runtimeRegistry.ensure(sessionId);
}

function normalizeImages(images: PiImageInput[] | undefined) {
  return images?.map((image) => ({
    type: 'image' as const,
    data: image.dataBase64,
    mimeType: image.mimeType ?? image.mediaType ?? 'image/png',
  }));
}

export async function injectPromptIfNeeded(deps: ClientDeps, sessionId: string): Promise<void> {
  const session = deps.runtimeRegistry.get(sessionId);
  if (!session) {
    console.log('[pi-client] injectPromptIfNeeded skipped — no session entry', { sessionId });
    return;
  }
  if (!session.prompt) {
    console.log('[pi-client] injectPromptIfNeeded skipped — no prompt to inject', { sessionId });
    return;
  }
  if (!session.agentSession) {
    console.log('[pi-client] injectPromptIfNeeded skipped — no agent session', { sessionId });
    return;
  }
  if (deps.runtimeRegistry.hasHistory(sessionId)) {
    console.log('[pi-client] injectPromptIfNeeded skipped — session already has history', { sessionId });
    return;
  }
  console.log('[pi-client] injectPromptIfNeeded → injecting role prompt', { sessionId, promptLen: session.prompt.length });
  try {
    await session.agentSession.prompt(session.prompt);
    console.log('[pi-client] injectPromptIfNeeded ← role prompt injected', { sessionId });
  } catch (err) {
    console.error('[pi-client] injectPromptIfNeeded failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
    throw err;
  }
}

export async function subscribeSession(
  deps: ClientDeps,
  sessionId: string,
  listener: (event: PiSessionStreamEvent) => void | Promise<void>,
): Promise<() => void> {
  const session = deps.runtimeRegistry.ensure(sessionId);
  session.listeners.add(listener);

  let runtimeUnsubscribe: (() => void) | undefined;
  if (session.agentSession) {
    const runId = `runtime_${crypto.randomUUID().slice(0, 10)}`;
    runtimeUnsubscribe = session.agentSession.subscribe((event) => {
      const mapped = mapAgentSessionEvent(sessionId, runId, event);
      if (!mapped) return;
      // 任何成功 mapped 的事件都算进展（含 tool_execution_start 映射的 activity）：
      // closeRuntime 卡死兜底按"连续无进展时长"判断，收到事件即刷新进度时间。
      session.lastStreamEventAt = Date.now();
      void listener(mapped);
    });
  }

  return () => {
    runtimeUnsubscribe?.();
    session.listeners.delete(listener);
  };
}

export async function getHistory(
  deps: ClientDeps,
  _sessionId: string,
  locator: PiSessionLocator,
  cursor?: string | null,
  limit = 50,
): Promise<PiHistoryPage> {
  return readHistory(locator, cursor, limit);
}

export async function sendMessage(
  deps: ClientDeps,
  sessionId: string,
  content: string,
  options?: { images?: PiImageInput[] },
): Promise<PiRunAccepted> {
  const session = getOrCreateSession(deps, sessionId);
  const runId = `run_${crypto.randomUUID().slice(0, 10)}`;

  if (session.agentSession) {
    // 一次新的 run 意味着用户重新激活会话，复位停止标记。
    // stopped 仅供 reloadIdleRuntimes 过滤"可回收"runtime 使用；
    // 不复位会让已停止的会话在下次 sendMessage 后仍被当作可回收。
    session.stopped = false;
    if (content || options?.images?.length) {
      // 用户消息
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
}

export async function steerSession(
  deps: ClientDeps,
  sessionId: string,
  content: string,
): Promise<PiSteerResult> {
  const session = deps.runtimeRegistry.get(sessionId);
  // 没有 live runtime（服务重启后 DB 仍是 running 等）时无法入队；调用方据此返回明确错误。
  if (!session?.agentSession) {
    throw new Error('pi_session_runtime_unavailable');
  }
  // 已发出 stop：stopSession 会 clearQueue，此时再入队会在下一次 prompt 被打出去（见下方注释）。
  if (session.stopped) {
    throw new Error('session_stopped');
  }
  // 必须要求有活跃 run：SDK 的 steer() 在 idle 下同样会无条件入队，会静默滞留到用户下一条消息。
  // run 刚结束、DB 尚未回落 idle 的窗口由此关闭（调用方把该错误当作「本轮已结束」）。
  if (!session.agentSession.isStreaming) {
    throw new Error('session_not_streaming');
  }
  await session.agentSession.steer(content);
  return { sessionId, queued: session.agentSession.getSteeringMessages().length };
}

export async function stopSession(deps: ClientDeps, sessionId: string) {
  const session = getOrCreateSession(deps, sessionId);
  session.stopped = true;
  const agentSession = session.agentSession;
  // 必须先丢弃排队中的插话：SDK 的 abort() 只中断当前 run，不清空 steering/followUp 队列，
  // 否则用户停止后队列里的消息会在下一次 prompt 时被一并投递出去。
  try {
    agentSession?.clearQueue();
  } catch {
    // clearQueue 是同步 API，理论上不抛；即便抛也不应阻塞停止流程。
  }
  // Fire abort in background — AgentSession.abort() waits for agent to become idle,
  // which can block indefinitely during LLM generation. The caller (API route) needs
  // to return 202 immediately and must not wait for the agent to wind down.
  // abort 收尾后再清一次：挡住 abort 展开期间（stopped 检查之前的极小窗口）新到的插话。
  // 条件收窄：若期间已有新 run 将 stopped 复位，则不得误删新 run 的队列。
  void agentSession
    ?.abort()
    .catch(() => {})
    .finally(() => {
      try {
        if (session.stopped) agentSession?.clearQueue();
      } catch {
        // 同上，清理失败不影响停止结果。
      }
    });
  return { status: 'stopped' as const };
}

export async function waitForSessionIdle(deps: ClientDeps, sessionId: string, timeoutMs: number): Promise<boolean> {
  const session = deps.runtimeRegistry.get(sessionId);
  const agentSession = session?.agentSession;
  if (!agentSession) return true;
  if (agentSession.isIdle) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      agentSession.waitForIdle().then(() => true, () => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
