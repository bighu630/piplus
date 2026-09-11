import React, { useMemo } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, LoaderCircle, Wrench } from 'lucide-react';
import { parseToolArgsJson } from '../lib/tool-summary';

/**
 * 单个工具调用卡片（非文件类：bash / grep / find / ls / spawn_session / ask_question 等）。
 * 交互与改动前一致：头部 chevron + 工具名，点击展开/收起 args。
 * write/edit/read 由 FileToolGroupCard 以「同回合多文件聚合卡片」展示。
 */
export interface ToolCallCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  /** 切换展开态；传 id 而非闭包，便于父级用 useCallback 稳定引用、让 memo 生效 */
  onToggle: (id: string) => void;
  running?: boolean;
  /** spawn_session 等工具的角色后缀，如 `worker` */
  roleSuffix?: string | null;
}

function ToolCallCard({
  msg,
  expanded,
  onToggle,
  running = false,
  roleSuffix = null,
}: ToolCallCardProps) {
  const toolName = msg.tool_name || 'unknown';
  const { argsStr, parsedArgs } = useMemo(
    () => parseToolArgsJson(msg.tool_args_json),
    [msg.tool_args_json],
  );

  const showArgsTable =
    (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs !== null;

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden transition-colors hover:bg-amber-100/80 dark:hover:bg-amber-900/40">
            <div
              data-testid="tool-call-header"
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

            {expanded && argsStr && (
              <div data-testid="tool-call-expanded">
                {showArgsTable && parsedArgs ? (
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
