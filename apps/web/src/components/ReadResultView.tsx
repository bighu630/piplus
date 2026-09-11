import React, { useMemo } from 'react';
import { isToolErrorMessage, READ_MAX_LINES, splitLineCount, splitReadContent } from '../lib/tool-summary';

/**
 * read 工具结果的展开内容：正文（超长截断、外层滚动）+ pi 续读提示（单独一行）+ 失败文本样式。
 * 不带行号（行号只在卡片摘要的 range 里显示）。
 */
function ReadResultView({ content }: { content: string }) {
  const parsed = useMemo(() => {
    const { body, notice } = splitReadContent(content);
    // 用 splitLineCount 计数（与摘要 +N 口径一致）：末尾换行不多算一行
    const totalLines = splitLineCount(body);
    const truncated = totalLines > READ_MAX_LINES;
    const lines = body === '' ? [] : body.split('\n');
    return {
      text: truncated ? lines.slice(0, READ_MAX_LINES).join('\n') : body,
      truncated,
      totalLines,
      notice,
      isError: isToolErrorMessage(body),
    };
  }, [content]);

  return (
    <div
      className={`border-t border-amber-200 dark:border-amber-800${
        parsed.isError ? ' bg-rose-50/60 dark:bg-rose-950/20' : ''
      }`}
    >
      {parsed.truncated && (
        <div className="px-3 py-1 text-[10px] italic text-slate-400 dark:text-slate-500 bg-slate-50/50 dark:bg-slate-800/30 border-b border-amber-100 dark:border-amber-800/30">
          仅显示前 {READ_MAX_LINES} 行（共 {parsed.totalLines} 行）
        </div>
      )}
      <div className="max-h-96 overflow-auto px-3 py-2">
        {parsed.text.trim() === '' ? (
          <div className="text-[10px] text-slate-400 dark:text-slate-500 italic">（空内容）</div>
        ) : (
          <pre
            className={`text-[11px] font-mono whitespace-pre leading-relaxed ${
              parsed.isError ? 'text-rose-700 dark:text-rose-400' : 'text-amber-900 dark:text-amber-200'
            }`}
          >
            {parsed.text}
          </pre>
        )}
      </div>
      {parsed.notice && (
        <div className="px-3 py-1 text-[10px] font-mono text-amber-600 dark:text-amber-400 border-t border-amber-100 dark:border-amber-800/50">
          {parsed.notice}
        </div>
      )}
    </div>
  );
}

export default React.memo(ReadResultView);
