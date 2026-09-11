import React, { useMemo } from 'react';
import { isToolErrorMessage, splitLineCount, TOOL_RESULT_MAX_LINES } from '../lib/tool-summary';

/**
 * 工具结果文本视图：失败红色 / 成功中性色，超长截断（统一 200 行）+ 容器内滚动。
 * 截断提示渲染在滚动容器之外，长输出场景无需滚到底部即可看到。
 */
function ToolResultView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    // 用 splitLineCount 计数（末尾换行不多算一行）
    const totalLines = splitLineCount(content);
    const truncated = totalLines > TOOL_RESULT_MAX_LINES;
    const lines = content === '' ? [] : content.split('\n');
    return {
      text: truncated ? lines.slice(0, TOOL_RESULT_MAX_LINES).join('\n') : content,
      truncated,
      totalLines,
      isError: isToolErrorMessage(content),
    };
  }, [content]);

  return (
    <div>
      {parsed.truncated && (
        <div className="px-3 py-1 text-[10px] italic text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-slate-800/30 border-b border-amber-100 dark:border-amber-800/30">
          仅显示前 {TOOL_RESULT_MAX_LINES} 行（共 {parsed.totalLines} 行）
        </div>
      )}
      <div className="max-h-96 overflow-auto px-3 py-2">
        {parsed.text.trim() === '' ? (
          <div className="text-[10px] text-slate-400 dark:text-slate-500 italic">（无输出）</div>
        ) : (
          <pre
            className={`text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed ${
              parsed.isError ? 'text-rose-700 dark:text-rose-400' : 'text-slate-700 dark:text-slate-300'
            }`}
          >
            {parsed.text}
          </pre>
        )}
      </div>
    </div>
  );
}

export default React.memo(ToolResultView);
