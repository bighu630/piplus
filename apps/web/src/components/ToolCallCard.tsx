import React, { useMemo } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, FileCode, LoaderCircle, Wrench } from 'lucide-react';
import DiffViewer from './DiffViewer';
import { formatReadLineRange, parseWriteEditDiff, summarizeWriteEdit } from '../lib/tool-summary';

/**
 * tool call 卡片：头部常显工具名与文件摘要（write/edit 路径 + 增删行数，read 路径 + 行号范围），
 * 明细默认收起，点击头部或「展开全部/收起全部」按钮切换。
 */
export interface ToolCallCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  onToggle: () => void;
  running?: boolean;
  /** spawn_session 等工具的角色后缀，如 `worker` */
  roleSuffix?: string | null;
  /** 对应 tool result 消息的 details（edit 的精确 diff 统计来源） */
  resultDetails?: unknown;
}

function ToolCallCard({
  msg,
  expanded,
  onToggle,
  running = false,
  roleSuffix = null,
  resultDetails = null,
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
  const readLineRange = toolName === 'read' && parsedArgs
    ? formatReadLineRange(parsedArgs)
    : null;

  const showArgsTable =
    (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs !== null;

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden transition-colors hover:bg-amber-100/80 dark:hover:bg-amber-900/40">
            <div
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={onToggle}
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

              {/* write/edit：文件路径 + 增删行数 */}
              {writeEditSummary && (
                <span className="flex items-center gap-1.5 min-w-0" data-testid="tool-call-meta">
                  <span className="w-px h-3 bg-amber-200 dark:bg-amber-800 shrink-0" aria-hidden />
                  <FileCode className="w-3.5 h-3.5 text-amber-600/80 dark:text-amber-400/80 shrink-0" />
                  <span
                    className="text-[11px] font-mono text-amber-800 dark:text-amber-300 truncate max-w-[300px]"
                    title={writeEditSummary.path ?? undefined}
                  >
                    {writeEditSummary.path ?? '(未提供路径)'}
                  </span>
                  <span className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                    +{writeEditSummary.added}
                  </span>
                  {writeEditSummary.removed > 0 && (
                    <span className="text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400 shrink-0">
                      -{writeEditSummary.removed}
                    </span>
                  )}
                </span>
              )}

              {/* read：文件路径 + 行号范围（无行号参数时不显示行号） */}
              {readPath && (
                <span className="flex items-center gap-1.5 min-w-0" data-testid="tool-call-meta">
                  <span className="w-px h-3 bg-amber-200 dark:bg-amber-800 shrink-0" aria-hidden />
                  <FileCode className="w-3.5 h-3.5 text-amber-600/80 dark:text-amber-400/80 shrink-0" />
                  <span
                    className="text-[11px] font-mono text-amber-800 dark:text-amber-300 truncate max-w-[300px]"
                    title={readPath}
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
                </span>
              )}

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle();
                }}
                className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-900/40 hover:bg-amber-200/70 dark:hover:bg-amber-800/50 transition-colors cursor-pointer shrink-0"
              >
                {expanded ? '收起全部' : '展开全部'}
              </button>
            </div>

            {expanded && argsStr && (
              <div data-testid="tool-call-expanded">
                {writeEditDiff && (toolName === 'write' || toolName === 'edit') ? (
                  <DiffViewer
                    oldText={writeEditDiff.oldText}
                    newText={writeEditDiff.newText}
                    viewType={toolName === 'write' ? 'write' : 'edit'}
                  />
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
                ) : (
                  <div className="border-t border-amber-200 dark:border-amber-800 px-3 py-2">
                    <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                      {argsStr}
                    </pre>
                  </div>
                )}
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
