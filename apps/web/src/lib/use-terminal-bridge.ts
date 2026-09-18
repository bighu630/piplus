import { useCallback, useEffect, useRef } from 'react';
import { useWebSocket } from './ws-provider';

interface TerminalMessage {
  type: string;
  sessionId: string;
  data?: string;
  cols?: number;
  rows?: number;
}

/**
 * 终端桥接：把 xterm 的输入经 WS 发到 pty，并把当前会话的 terminal_output / terminal_exit
 * 写回终端；进程退出后延迟自动重启 pty（便于看到退出信息）。
 */
export function useTerminalBridge(selectedSessionId: string | null) {
  const { subscribeToMessages, sendRaw } = useWebSocket();
  const terminalRef = useRef<any>(null);

  const handleTerminalMessage = useCallback((msg: TerminalMessage) => {
    sendRaw({
      kind: 'client',
      type: msg.type,
      payload: {
        sessionId: msg.sessionId,
        ...(msg.data !== undefined ? { data: msg.data } : {}),
        ...(msg.cols !== undefined ? { cols: msg.cols } : {}),
        ...(msg.rows !== undefined ? { rows: msg.rows } : {}),
      },
    });
  }, [sendRaw]);

  useEffect(() => {
    const sessionId = selectedSessionId;
    const unsub = subscribeToMessages((msg: any) => {
      if (msg.kind === 'terminal' && msg.type === 'terminal_output' && msg.payload.sessionId === sessionId) {
        terminalRef.current?.write(msg.payload.data);
      }
      if (msg.kind === 'terminal' && msg.type === 'terminal_exit' && msg.payload.sessionId === sessionId) {
        const code = msg.payload.code;
        terminalRef.current?.write(`\r\n\x1b[1;31m[进程退出，代码: ${code}]\x1b[0m\r\n`);
        // Auto-restart pty after brief delay so output can be seen
        setTimeout(() => {
          sendRaw({
            kind: 'client',
            type: 'terminal_start',
            payload: { sessionId, cols: 80, rows: 24 },
          });
        }, 500);
      }
    });
    return unsub;
  }, [subscribeToMessages, selectedSessionId, sendRaw]);

  return { terminalRef, handleTerminalMessage };
}
