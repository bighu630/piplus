import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import type { PiSessionLocator } from '../locator';
import type {
  PiCompleteModelInput,
  PiCompleteModelResult,
  PiModelInfo,
} from '../types';
import type { ClientDeps } from './deps';
import { sessionFileHasModelChange } from './session-lifecycle';

function buildCompleteModelContext(input: PiCompleteModelInput): Parameters<ModelRuntime['completeSimple']>[1] {
  return {
    systemPrompt: input.systemPrompt,
    messages: input.messages.map((msg) => ({
      role: msg.role,
      timestamp: Date.now(),
      content: msg.images?.length
        ? [
            ...(msg.content ? [{ type: 'text' as const, text: msg.content }] : []),
            ...msg.images.map((image) => ({
              type: 'image' as const,
              data: image.dataBase64,
              mimeType: image.mimeType ?? image.mediaType ?? 'image/png',
            })),
          ]
        : msg.content,
    })),
  };
}

export async function listAvailableModels(deps: ClientDeps) {
  const models = await deps.modelRegistry.getAvailable();
  return models.map((m) => ({
    provider: m.provider,
    id: m.id,
    label: m.name ?? m.id,
    reasoning: m.reasoning ?? false,
    input: m.input as string[] | undefined,
    thinkingLevelMap: m.thinkingLevelMap as Record<string, string | null> | undefined,
    availableThinkingLevels: getSupportedThinkingLevels(m),
  }));
}

export async function getCurrentModel(deps: ClientDeps, sessionId: string) {
  const session = deps.runtimeRegistry.get(sessionId);
  // 优先返回 registry 中缓存的模型（用户手动设置的），agentSession.model 可能被 bindToolRuntime 覆盖
  return session?.model ?? null;
}

export async function completeModel(deps: ClientDeps, input: PiCompleteModelInput): Promise<PiCompleteModelResult> {
  const model = deps.modelRuntime.getModel(input.provider, input.id);
  if (!model) {
    throw new Error(`model_not_found: ${input.provider}/${input.id}`);
  }
  const message = await deps.modelRuntime.completeSimple(
    model,
    buildCompleteModelContext(input),
    {
      maxTokens: input.maxTokens,
      signal: input.signal,
    },
  );
  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => (block as { type: 'text'; text: string }).text)
    .join('\n');
  return { text, stopReason: message.stopReason, errorMessage: message.errorMessage };
}

export async function setSessionModel(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
  modelRef: { provider: string; id: string },
  cwd?: string,
): Promise<PiModelInfo> {
  let session = deps.runtimeRegistry.ensure(sessionId, locator, cwd);
  console.log('[pi-client] setSessionModel start', {
    sessionId,
    locatorFile: locator.sessionFile,
    provider: modelRef.provider,
    id: modelRef.id,
    cwd: cwd ?? session.cwd,
  });

  const available = await deps.modelRegistry.getAvailable();
  const target = available.find((m) => m.provider === modelRef.provider && m.id === modelRef.id);
  if (!target) throw new Error('pi_model_not_found');

  if (!session.agentSession) {
    await deps.client.restoreRuntime(sessionId, locator, cwd);
    session = deps.runtimeRegistry.ensure(sessionId, locator, cwd);
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
}

export async function getThinkingLevel(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
  cwd?: string,
): Promise<string | null> {
  let session = deps.runtimeRegistry.get(sessionId);
  if (!session?.agentSession) {
    await deps.client.restoreRuntime(sessionId, locator, cwd);
    session = deps.runtimeRegistry.get(sessionId);
  }
  if (session?.agentSession) {
    return session.agentSession.thinkingLevel as string;
  }
  return null;
}

export async function getAvailableThinkingLevels(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
  cwd?: string,
): Promise<string[]> {
  let session = deps.runtimeRegistry.get(sessionId);
  if (!session?.agentSession) {
    await deps.client.restoreRuntime(sessionId, locator, cwd);
    session = deps.runtimeRegistry.get(sessionId);
  }
  if (session?.agentSession) {
    const levels = session.agentSession.getAvailableThinkingLevels();
    return levels.map((l: any) => String(l));
  }
  return [];
}

export async function setThinkingLevel(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
  level: string,
  cwd?: string,
): Promise<string> {
  let session = deps.runtimeRegistry.get(sessionId);
  if (!session?.agentSession) {
    await deps.client.restoreRuntime(sessionId, locator, cwd);
    session = deps.runtimeRegistry.get(sessionId);
  }
  if (!session?.agentSession) {
    throw new Error('pi_session_runtime_unavailable');
  }
  if (session.agentSession.isStreaming) {
    throw new Error('pi_session_busy');
  }
  session.agentSession.setThinkingLevel(level as any);
  return session.agentSession.thinkingLevel as string;
}
