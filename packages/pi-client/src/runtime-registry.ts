import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { PiSessionLocator } from './locator';
import type { PiMessage, PiSessionStreamEvent, PiToolDef } from './types';

type SessionListener = (event: PiSessionStreamEvent) => void | Promise<void>;

export type ActiveSessionRuntime = {
  locator: PiSessionLocator;
  cwd: string;
  agentSession?: AgentSession;
  model?: { provider: string; id: string; label: string };
  toolHandler?: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>;
  toolDefs?: PiToolDef[];
  messages: PiMessage[];
  stopped: boolean;
  prompt: string;
  promptSent: boolean;
  title: string | null;
  listeners: Set<SessionListener>;
};

export class RuntimeRegistry {
  private sessions = new Map<string, ActiveSessionRuntime>();

  get(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  ensure(sessionId: string, locator?: PiSessionLocator, cwd?: string) {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (locator) existing.locator = locator;
      if (cwd) existing.cwd = cwd;
      return existing;
    }

    const created: ActiveSessionRuntime = {
      locator: locator ?? {
        piSessionId: sessionId,
        sessionFile: `/tmp/${sessionId}.jsonl`,
      },
      cwd: cwd ?? process.cwd(),
      messages: [],
      stopped: false,
      prompt: '',
      promptSent: false,
      title: null,
      listeners: new Set(),
    };
    this.sessions.set(sessionId, created);
    return created;
  }

  delete(sessionId: string) {
    this.sessions.delete(sessionId);
  }
}
