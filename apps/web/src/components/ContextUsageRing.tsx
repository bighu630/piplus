import React from 'react';
import { useSessionContextUsage } from '../lib/hooks';

interface ContextUsageRingProps {
  sessionId: string | null;
}

function getColor(percent: number | null): string {
  if (percent === null || percent === undefined) return '#94a3b8';
  if (percent < 60) return '#22c55e';
  if (percent < 85) return '#eab308';
  return '#ef4444';
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return '--';
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(1)}k`;
}

export default function ContextUsageRing({ sessionId }: ContextUsageRingProps) {
  const { data: usage, isLoading } = useSessionContextUsage(sessionId);
  const percent = usage?.percent ?? null;
  const tokens = usage?.tokens ?? null;
  const contextWindow = usage?.context_window ?? 0;

  const color = getColor(percent);
  const radius = 9;
  const circumference = 2 * Math.PI * radius;
  const offset = percent !== null ? circumference * (1 - Math.min(percent, 100) / 100) : circumference;

  return (
    <div className="relative inline-flex items-center group">
      <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        className="shrink-0"
        aria-label="Context usage"
      >
        {/* Background circle */}
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          strokeWidth="3"
          className="stroke-slate-200 dark:stroke-slate-700"
        />
        {/* Foreground circle (progress) */}
        <circle
          cx="12"
          cy="12"
          r={radius}
          fill="none"
          strokeWidth="3"
          stroke={color}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 12 12)"
          className="transition-all duration-500 ease-out"
        />
      </svg>
      {/* Tooltip on hover */}
      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 hidden group-hover:block z-50">
        <div className="bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 shadow-lg whitespace-nowrap">
          <div className="text-[11px] text-slate-700 dark:text-slate-200 font-semibold">
            {isLoading
              ? '加载中…'
              : percent !== null
                ? `${percent.toFixed(1)}%（${formatTokens(tokens)} / ${formatTokens(contextWindow)} tokens）`
                : '暂无数据'}
          </div>
        </div>
        <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-0.5">
          <div className="border-4 border-transparent border-t-white dark:border-t-slate-800" />
        </div>
      </div>
    </div>
  );
}
