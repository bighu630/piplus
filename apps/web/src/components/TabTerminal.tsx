import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface TabTerminalProps {
  sessionId: string;
  theme: 'light' | 'dark';
  visible?: boolean;
  onTerminalMessage: (msg: {
    type: string;
    sessionId: string;
    data?: string;
    cols?: number;
    rows?: number;
  }) => void;
}

export type TabTerminalHandle = {
  write: (data: string) => void;
};

const THEMES = {
  dark: {
    background: '#1e1e2e',
    cursor: '#f5e0dc',
    foreground: '#cdd6f4',
    selectionBackground: '#585b70',
  },
  light: {
    background: '#eff1f5',
    cursor: '#dc8a78',
    foreground: '#4c4f69',
    selectionBackground: '#acb0be',
  },
} as const;

const TabTerminal = forwardRef<TabTerminalHandle, TabTerminalProps>(
  ({ sessionId, theme, visible = true, onTerminalMessage }, ref) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalRef = useRef<Terminal | null>(null);
    const fitAddonRef = useRef<FitAddon | null>(null);
    const onTerminalMessageRef = useRef(onTerminalMessage);
    const startedRef = useRef(false);

    // Keep callback ref up to date to avoid stale closures inside the one-time effect
    useEffect(() => {
      onTerminalMessageRef.current = onTerminalMessage;
    }, [onTerminalMessage]);

    // Expose write method to parent via ref
    useImperativeHandle(
      ref,
      () => ({
        write: (data: string) => {
          terminalRef.current?.write(data);
        },
      }),
      [],
    );

    // Terminal lifecycle: create on mount, destroy on unmount
    useEffect(() => {
      const colors = THEMES[theme];

      const terminal = new Terminal({
        theme: {
          background: colors.background,
          cursor: colors.cursor,
          foreground: colors.foreground,
          selectionBackground: colors.selectionBackground,
        },
        fontFamily: 'JetBrains Mono, Fira Code, monospace',
        fontSize: 14,
        cursorBlink: true,
        cursorStyle: 'block',
        allowTransparency: true,
      });

      const fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);

      terminal.open(containerRef.current!);
      fitAddon.fit();

      terminalRef.current = terminal;
      fitAddonRef.current = fitAddon;

      // Send terminal_start with initial dimensions
      const dimensions = fitAddon.proposeDimensions();
      if (dimensions && dimensions.cols > 0 && dimensions.rows > 0) {
        startedRef.current = true;
        onTerminalMessageRef.current({
          type: 'terminal_start',
          sessionId,
          cols: dimensions.cols,
          rows: dimensions.rows,
        });
      }

      // Forward user input to parent
      terminal.onData((data) => {
        onTerminalMessageRef.current({
          type: 'terminal_input',
          sessionId,
          data,
        });
      });

      // Observe container size changes
      const resizeObserver = new ResizeObserver(() => {
        try {
          fitAddon.fit();
        } catch { /* ignore */ }
        const dims = fitAddon.proposeDimensions();
        if (dims) {
          onTerminalMessageRef.current({
            type: 'terminal_resize',
            sessionId,
            cols: dims.cols,
            rows: dims.rows,
          });
        }
      });
      if (containerRef.current) {
        resizeObserver.observe(containerRef.current);
      }

      // Cleanup on unmount
      return () => {
        resizeObserver.disconnect();
        onTerminalMessageRef.current({
          type: 'terminal_stop',
          sessionId,
        });
        terminal.dispose();
        terminalRef.current = null;
        fitAddonRef.current = null;
      };
      // Recreate terminal when sessionId changes (component key handles remount)
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Update terminal theme when theme prop changes without remounting
    useEffect(() => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const colors = THEMES[theme];
      terminal.options.theme = {
        background: colors.background,
        cursor: colors.cursor,
        foreground: colors.foreground,
        selectionBackground: colors.selectionBackground,
      };
    }, [theme]);

    // Send terminal_start when first becoming visible
    useEffect(() => {
      console.log('[Terminal] visible effect fired', { visible, started: startedRef.current, sessionId });
      if (!visible || startedRef.current) return;
      const fitAddon = fitAddonRef.current;
      const terminal = terminalRef.current;
      console.log('[Terminal] refs:', { hasFitAddon: !!fitAddon, hasTerminal: !!terminal });
      if (!fitAddon || !terminal) return;
      // Need to wait a tick for the display:block to take effect
      requestAnimationFrame(() => {
        try {
          fitAddon.fit();
        } catch (e) { console.error('[Terminal] fit error:', e); }
        const dims = fitAddon.proposeDimensions();
        console.log('[Terminal] proposeDimensions:', dims);
        if (dims && dims.cols > 0 && dims.rows > 0) {
          startedRef.current = true;
          const msg = {
            type: 'terminal_start',
            sessionId,
            cols: dims.cols,
            rows: dims.rows,
          };
          console.log('[Terminal] sending terminal_start:', msg);
          onTerminalMessageRef.current(msg);
        }
      });
    }, [visible, sessionId]);

    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: visible ? 'block' : 'none',
        }}
      >
        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>
    );
  },
);

TabTerminal.displayName = 'TabTerminal';

export default TabTerminal;
