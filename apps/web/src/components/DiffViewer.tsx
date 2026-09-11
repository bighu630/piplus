import React from 'react';
import type { DiffLine } from '../lib/diff';
import { computeLineDiff, computeWriteDiff, truncateDiff } from '../lib/diff';

const MAX_DIFF_LINES = 150;

interface DiffViewerProps {
  oldText?: string;
  newText: string;
  viewType: 'edit' | 'write';
}

/**
 * write/edit 的 diff 明细（文件名与增删行数摘要由 tool call 卡片头部负责，此处只渲染明细行）。
 */
function DiffViewer({ oldText, newText, viewType }: DiffViewerProps) {
  const rawLines: DiffLine[] =
    viewType === 'edit' && oldText !== undefined
      ? computeLineDiff(oldText, newText)
      : computeWriteDiff(newText);

  const { lines, truncated } = truncateDiff(rawLines, MAX_DIFF_LINES);

  return (
    <div className="border-t border-amber-200 dark:border-amber-800">
      {truncated && (
        <div className="px-3 py-1 text-[10px] text-slate-400 dark:text-slate-500 italic bg-slate-50/50 dark:bg-slate-800/30 border-b border-amber-100 dark:border-amber-800/30">
          Diff 过长，仅显示前后部分（共 {rawLines.length} 行）
        </div>
      )}
      <div className="overflow-x-auto font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => {
          let rowClass = 'text-slate-600 dark:text-slate-300';
          let sign = ' ';

          if (line.type === 'add') {
            rowClass = 'bg-emerald-50/70 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300';
            sign = '+';
          } else if (line.type === 'delete') {
            rowClass = 'bg-rose-50/70 dark:bg-rose-950/20 text-rose-800 dark:text-rose-300';
            sign = '-';
          }

          return (
            <div
              key={index}
              data-testid="diff-line"
              data-line-type={line.type}
              className={`flex items-start px-3 py-0.5 ${rowClass}`}
            >
              <span className="w-5 shrink-0 text-center select-none font-mono text-[11px] font-bold opacity-70 leading-relaxed">
                {sign}
              </span>
              <span className="pl-1 whitespace-pre break-all min-w-0 leading-relaxed">
                {line.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(DiffViewer);
