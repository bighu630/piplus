import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { PiSessionLocator } from '../locator';
import type { PiContextUsage } from '../types';
import type { ClientDeps } from './deps';

export async function getContextUsage(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
): Promise<PiContextUsage | null> {
  const session = deps.runtimeRegistry.get(sessionId);

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
        const available = await deps.modelRegistry.getAvailable();
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
}

export async function compactSession(
  deps: ClientDeps,
  sessionId: string,
  locator: PiSessionLocator,
  cwd?: string,
): Promise<void> {
  const session = deps.runtimeRegistry.ensure(sessionId, locator, cwd);

  if (!session.agentSession) {
    await deps.client.restoreRuntime(sessionId, locator, cwd);
  }

  if (!session.agentSession) {
    throw new Error('pi_session_runtime_unavailable');
  }

  if (session.agentSession.isStreaming) {
    throw new Error('pi_session_busy');
  }

  await session.agentSession.compact();
}
