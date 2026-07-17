import React, { useState } from 'react';
import { ChevronDown, ChevronRight, FileCode } from 'lucide-react';
import type { DiffLine } from '../lib/diff';
import { computeLineDiff, computeWriteDiff, truncateDiff } from '../lib/diff';

const MAX_DIFF_LINES = 150;

interface DiffViewerProps {
  oldText?: string;
  newText: string;
  filename?: string;
  viewType: 'edit' | 'write';
}

function DiffViewer({ oldText, newText, filename, viewType }: DiffViewerProps) {
  const [collapsed, setCollapsed] = useState(false);

  const rawLines: DiffLine[] =
    viewType === 'edit' && oldText !== undefined
      ? computeLineDiff(oldText, newText)
      : computeWriteDiff(newText);

  const { lines, truncated } = truncateDiff(rawLines, MAX_DIFF_LINES);
  const addCount = rawLines.filter((l) => l.type === 'add').length;
  const deleteCount = rawLines.filter((l) => l.type === 'delete').length;

  return (
    <div className="border-t border-amber-200 dark:border-amber-800">
      {/* Summary bar */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-amber-50/50 dark:bg-amber-950/20 border-b border-amber-100 dark:border-amber-800/50">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-[11px] font-mono font-semibold text-amber-800 dark:text-amber-300 truncate">
            {filename ?? (viewType === 'edit' ? '编辑' : '新建文件')}
          </span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {addCount > 0 && (
            <span className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400">
              +{addCount}
            </span>
          )}
          {deleteCount > 0 && (
            <span className="text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400">
              -{deleteCount}
            </span>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="p-0.5 rounded hover:bg-amber-200/50 dark:hover:bg-amber-800/50 text-amber-500 dark:text-amber-400 cursor-pointer transition-colors"
          >
            {collapsed ? (
              <ChevronRight className="w-3.5 h-3.5" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>

      {/* Diff content */}
      {!collapsed && (
        <div className="overflow-x-auto font-mono text-[11px] leading-relaxed">
          {truncated && (
            <div className="px-3 py-1 text-[10px] text-slate-400 dark:text-slate-500 italic bg-slate-50/50 dark:bg-slate-800/30 border-b border-amber-100 dark:border-amber-800/30">
              Diff 过长，仅显示前后部分（共 {rawLines.length} 行）
            </div>
          )}
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
      )}
    </div>
  );
}

export default React.memo(DiffViewer);
