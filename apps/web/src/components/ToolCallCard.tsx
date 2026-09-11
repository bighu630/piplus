import React, { useMemo } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, FileCode, LoaderCircle, Wrench } from 'lucide-react';
import DiffViewer from './DiffViewer';
import { formatReadLineRange, parseWriteEditDiff, summarizeWriteEdit } from '../lib/tool-summary';

/** read 内容展示上限：pi 单次最多读 2000 行，避免超长文件展开时渲染过多 DOM */
const READ_MAX_LINES = 500;

/**
 * tool call 卡片。
 * - 头部：chevron + 工具名，点击展开/收起（保持既有交互）
 * - write/edit/read：头部下方常显文件摘要行（文件 + 增删行数 / 行号范围），行内与「展开全部/收起全部」按钮均可切换明细
 * - 其它工具：头部点击展开 args，与改动前一致
 */
export interface ToolCallCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  /** 切换展开态；传 id 而非闭包，便于父级用 useCallback 稳定引用、让 memo 生效 */
  onToggle: (id: string) => void;
  running?: boolean;
  /** spawn_session 等工具的角色后缀，如 `worker` */
  roleSuffix?: string | null;
  /** 对应 tool result 消息的 details（edit 的精确 diff 统计来源） */
  resultDetails?: unknown;
  /** 对应 tool result 消息的文本（read 展开时展示的读取内容） */
  resultContent?: string | null;
}

function ToolCallCard({
  msg,
  expanded,
  onToggle,
  running = false,
  roleSuffix = null,
  resultDetails = null,
  resultContent = null,
}: ToolCallCardProps) {
  const toolName = msg.tool_name || 'unknown';

  const { argsStr, parsedArgs } = useMemo(() => {
    if (!msg.tool_args_json) return { argsStr: '', parsedArgs: null as Record<string, unknown> | null };
    try {
      const parsed: unknown = JSON.parse(msg.tool_args_json);
      const str = JSON.stringify(parsed, null, 2);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { argsStr: str, parsedArgs: parsed as Record<string, unknown> };
      }
      return { argsStr: str, parsedArgs: null };
    } catch {
      return { argsStr: msg.tool_args_json, parsedArgs: null };
    }
  }, [msg.tool_args_json]);

  const writeEditSummary = useMemo(
    () => (parsedArgs ? summarizeWriteEdit(toolName, parsedArgs, resultDetails) : null),
    [toolName, parsedArgs, resultDetails],
  );
  const writeEditDiff = useMemo(
    () => (parsedArgs ? parseWriteEditDiff(toolName, parsedArgs) : null),
    [toolName, parsedArgs],
  );

  const readPath = toolName === 'read' && parsedArgs && typeof parsedArgs.path === 'string'
    ? parsedArgs.path
    : null;
  // 注：这是「请求范围」而非文件实际内容范围（offset 超出文件尾或文件更短时会偏大）
  const readLineRange = toolName === 'read' && parsedArgs
    ? formatReadLineRange(parsedArgs)
    : null;

  const readContent = useMemo(() => {
    if (toolName !== 'read' || resultContent == null) return null;
    const lines = resultContent.split('\n');
    if (lines.length <= READ_MAX_LINES) {
      return { text: resultContent, truncated: false, totalLines: lines.length };
    }
    return {
      text: lines.slice(0, READ_MAX_LINES).join('\n'),
      truncated: true,
      totalLines: lines.length,
    };
  }, [toolName, resultContent]);

  const hasMetaRow = writeEditSummary !== null || readPath !== null;
  const showArgsTable =
    (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs !== null;

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden transition-colors hover:bg-amber-100/80 dark:hover:bg-amber-900/40">
            <div
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={() => onToggle(msg.id)}
            >
              {expanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              )}
              <Wrench className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-xs font-semibold text-amber-800 dark:text-amber-300 font-mono">
                {toolName}
                {roleSuffix ? ` (${roleSuffix})` : ''}
              </span>
            </div>

            {/* write/edit/read：文件摘要行（常显，点击行或按钮切换明细） */}
            {hasMetaRow && (
              <div className="px-3 pb-2 flex items-center gap-2 min-w-0">
                <span
                  className="flex items-center gap-1.5 min-w-0 cursor-pointer"
                  data-testid="tool-call-meta"
                  onClick={() => onToggle(msg.id)}
                >
                  <FileCode className="w-3.5 h-3.5 text-amber-600/80 dark:text-amber-400/80 shrink-0" />
                  {writeEditSummary ? (
                    <>
                      <span
                        className="text-[11px] font-mono text-amber-800 dark:text-amber-300 truncate max-w-[300px]"
                        title={writeEditSummary.path ?? undefined}
                      >
                        {writeEditSummary.path ?? '(未提供路径)'}
                      </span>
                      {(writeEditSummary.added > 0 || writeEditSummary.removed === 0) && (
                        <span className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                          +{writeEditSummary.added}
                        </span>
                      )}
                      {writeEditSummary.removed > 0 && (
                        <span className="text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400 shrink-0">
                          -{writeEditSummary.removed}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span
                        className="text-[11px] font-mono text-amber-800 dark:text-amber-300 truncate max-w-[300px]"
                        title={readPath ?? undefined}
                      >
                        {readPath}
                      </span>
                      {readLineRange && (
                        <span
                          data-testid="tool-call-line-range"
                          className="text-[10px] font-mono font-bold text-amber-700 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-900/50 rounded px-1 py-px shrink-0"
                        >
                          {readLineRange}
                        </span>
                      )}
                    </>
                  )}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggle(msg.id);
                  }}
                  className="px-1.5 py-0.5 rounded text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-900/40 hover:bg-amber-200/70 dark:hover:bg-amber-800/50 transition-colors cursor-pointer shrink-0"
                >
                  {expanded ? '收起全部' : '展开全部'}
                </button>
              </div>
            )}

            {expanded && (argsStr || readContent) && (
              <div data-testid="tool-call-expanded">
                {writeEditDiff && (toolName === 'write' || toolName === 'edit') ? (
                  <DiffViewer
                    oldText={writeEditDiff.oldText}
                    newText={writeEditDiff.newText}
                    viewType={toolName === 'write' ? 'write' : 'edit'}
                  />
                ) : readContent ? (
                  <div className="border-t border-amber-200 dark:border-amber-800 max-h-96 overflow-y-auto px-3 py-2">
                    {readContent.text === '' ? (
                      <div className="text-[10px] text-slate-400 dark:text-slate-500 italic">（空内容）</div>
                    ) : (
                      <pre className="text-[11px] font-mono text-amber-900 dark:text-amber-200 whitespace-pre-wrap break-all leading-relaxed">
                        {readContent.text}
                      </pre>
                    )}
                    {readContent.truncated && (
                      <div className="mt-1 text-[10px] text-slate-400 dark:text-slate-500 italic">
                        仅显示前 {READ_MAX_LINES} 行（共 {readContent.totalLines} 行）
                      </div>
                    )}
                  </div>
                ) : showArgsTable && parsedArgs ? (
                  <div className="border-t border-amber-200 dark:border-amber-800 px-3 py-2">
                    <table className="w-full text-[11px] font-mono leading-relaxed">
                      <tbody>
                        {Object.entries(parsedArgs).map(([key, value]) => (
                          <tr key={key} className="border-b border-amber-100 dark:border-amber-800/50 last:border-b-0">
                            <td className="text-amber-700 dark:text-amber-400 font-semibold pr-3 py-1 align-top whitespace-nowrap">
                              {key}
                            </td>
                            <td className="text-amber-900 dark:text-amber-200 py-1 break-words">
                              {typeof value === 'object' && value !== null
                                ? JSON.stringify(value)
                                : String(value)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : argsStr ? (
                  <div className="border-t border-amber-200 dark:border-amber-800 px-3 py-2">
                    <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                      {argsStr}
                    </pre>
                  </div>
                ) : null}
              </div>
            )}
          </div>
          {running && (
            <div className="ml-2 pt-2 shrink-0">
              <LoaderCircle className="w-4 h-4 text-indigo-500 animate-spin" />
            </div>
          )}
        </div>
        <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1 font-mono">
          {new Date(msg.created_at).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

export default React.memo(ToolCallCard);
