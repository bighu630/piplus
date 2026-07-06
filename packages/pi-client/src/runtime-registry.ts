import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { PiSessionLocator } from './locator';
import type { PiMessage, PiSessionStreamEvent, PiSlashCommandInfo, PiToolDef } from './types';

type SessionListener = (event: PiSessionStreamEvent) => void | Promise<void>;

export type ActiveSessionRuntime = {
  locator: PiSessionLocator;
  cwd: string;
  agentSession?: AgentSession;
  model?: { provider: string; id: string; label: string };
  toolHandler?: (toolName: string, args: Record<string, unknown>, context: { sessionId: string }) => Promise<unknown>;
  toolDefs?: PiToolDef[];
  commands: PiSlashCommandInfo[];
  messages: PiMessage[];
  stopped: boolean;
  prompt: string;
  promptSent: boolean;
  title: string | null;
  listeners: Set<SessionListener>;
  idleCleanupTimer?: ReturnType<typeof setTimeout>;
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
      commands: [],
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

  /** List all active session runtimes (for iteration). */
  list(): ActiveSessionRuntime[] {
    return Array.from(this.sessions.values());
  }

  /** Check if a session has history (user/assistant messages). */
  hasHistory(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.locator?.sessionFile) return false;
    try {
      const entries = SessionManager.open(session.locator.sessionFile).getEntries();
      return entries.some((entry: any) => entry?.type === 'message');
    } catch {
      return false;
    }
  }

  isFirstConversation(sessionId: string): boolean {
    return !this.hasHistory(sessionId);
  }

  getRuntimeState(sessionId: string): { ready: boolean; isFirst: boolean; prompt?: string } | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      ready: !!session.agentSession,
      isFirst: !this.hasHistory(sessionId),
      prompt: session.prompt,
    };
  }

  /** Close idle runtimes: dispose runtimes that are not actively running.
   *  Returns the number of runtimes closed. */
  closeIdle(dispose: (session: ActiveSessionRuntime) => void): number {
    let closed = 0;
    for (const session of this.sessions.values()) {
      if (session.stopped && session.agentSession) {
        dispose(session);
        closed++;
      }
    }
    return closed;
  }
}
