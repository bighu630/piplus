import React, { useCallback, useEffect, useState } from 'react';

interface MermaidBlockProps {
  chart: string;
}

const MAX_CHART_LENGTH = 50 * 1024;

const THEMES = ['default', 'dark', 'neutral', 'forest'] as const;
type MermaidTheme = (typeof THEMES)[number];

export default function MermaidBlock({ chart }: MermaidBlockProps) {
  const [themeIndex, setThemeIndex] = useState(() => {
    const isDark = document.documentElement.classList.contains('dark');
    return isDark ? 1 : 0;
  });
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);

  const userTheme: MermaidTheme = THEMES[themeIndex];

  const cycleTheme = useCallback(() => {
    setThemeIndex((prev) => (prev + 1) % THEMES.length);
  }, []);

  // Render mermaid
  useEffect(() => {
    setError(null);
    setSvg(null);

    if (!chart) return;
    if (chart.length > MAX_CHART_LENGTH) {
      setError(`图表过长（${(chart.length / 1024).toFixed(1)}KB，限制 50KB）`);
      return;
    }

    let cancelled = false;

    const render = async () => {
      try {
        const mermaid = await import('mermaid');
        mermaid.default.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: userTheme,
        });

        const id = `mermaid-${Math.random().toString(36).slice(2, 10)}`;
        const { svg: renderedSvg } = await mermaid.default.render(id, chart);

        if (!cancelled) {
          setSvg(renderedSvg);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : '未知错误');
        }
      }
    };

    render();
    return () => { cancelled = true; };
  }, [chart, userTheme]);

  // Fallback on error
  if (error) {
    return (
      <div className="my-3 border border-red-200 dark:border-red-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900">
        <div className="bg-red-50 dark:bg-red-950 px-4 py-1.5 text-xs text-red-600 dark:text-red-400 border-b border-red-200 dark:border-red-800">
          Mermaid 渲染失败：{error}
        </div>
        <pre className="p-4 overflow-x-auto text-[11.5px] leading-relaxed text-slate-800 dark:text-slate-200 bg-white dark:bg-slate-950">
          <code>{chart}</code>
        </pre>
      </div>
    );
  }

  return (
    <div className="my-3 border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-slate-50 dark:bg-slate-900">
      <div className="bg-slate-100/80 dark:bg-slate-800 px-4 py-1.5 flex items-center justify-between text-slate-500 dark:text-slate-400 border-b border-slate-200 dark:border-slate-800 select-none">
        <span className="text-[10px] font-mono font-bold uppercase tracking-wider">mermaid</span>
        <button
          type="button"
          onClick={cycleTheme}
          className="flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700 bg-white/60 dark:bg-slate-700/60 text-slate-500 dark:text-slate-400 hover:bg-white dark:hover:bg-slate-700 cursor-pointer transition-colors"
          title="切换 Mermaid 主题"
        >
          <span>主题:</span>
          <span className="font-semibold text-slate-600 dark:text-slate-300">{userTheme}</span>
        </button>
      </div>
      <div
        className="p-4 overflow-x-auto bg-white dark:bg-slate-950 flex justify-center [&_svg]:max-w-none"
        dangerouslySetInnerHTML={svg ? { __html: svg } : undefined}
      />
    </div>
  );
}
