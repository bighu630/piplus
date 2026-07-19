import { spawn, type IPty } from 'bun-pty';

type OutputCallback = (sessionId: string, data: string) => void;
type ExitCallback = (sessionId: string, code: number) => void;

export class TerminalManager {
  private sessions = new Map<string, IPty>();
  private onOutput: OutputCallback;
  private onExit: ExitCallback;

  constructor(onOutput: OutputCallback, onExit: ExitCallback) {
    this.onOutput = onOutput;
    this.onExit = onExit;
  }

  start(sessionId: string, projectPath: string, cols: number, rows: number): void {
    if (this.sessions.has(sessionId)) {
      console.log('[pty] already running for', sessionId);
      return;
    }

    const shell = process.platform === 'win32' ? 'cmd.exe' : 'bash';
    console.log('[pty] spawning', { shell, sessionId, projectPath, cols, rows });
    try {
      const term = spawn(shell, [], {
        name: 'xterm-color',
        cols,
        rows,
        cwd: projectPath,
      });
      console.log('[pty] spawned OK, pid:', term.pid);
      term.onData((data: string) => {
        console.log('[pty] data from', sessionId, 'len:', data.length);
        this.onOutput(sessionId, data);
      });
      term.onExit(({ exitCode }: { exitCode: number }) => {
        console.log('[pty] exit for', sessionId, 'code:', exitCode);
        this.sessions.delete(sessionId);
        this.onExit(sessionId, exitCode);
      });
      this.sessions.set(sessionId, term);
    } catch (err) {
      console.log('[pty] spawn ERROR:', err);
    }
  }

  write(sessionId: string, data: string): void {
    const term = this.sessions.get(sessionId);
    if (!term) return;
    term.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const term = this.sessions.get(sessionId);
    if (!term) return;
    term.resize(cols, rows);
  }

  stop(sessionId: string): void {
    const term = this.sessions.get(sessionId);
    if (!term) return;
    term.kill();
    this.sessions.delete(sessionId);
  }

  stopAll(): void {
    for (const [id, term] of this.sessions) {
      term.kill();
    }
    this.sessions.clear();
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get size(): number {
    return this.sessions.size;
  }
}
