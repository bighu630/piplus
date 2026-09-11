import React, { useEffect, useMemo, useState } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, LoaderCircle, Wrench } from 'lucide-react';
import ToolResultView from './ToolResultView';
import { isToolErrorMessage, parseToolArgsJson } from '../lib/tool-summary';

/**
 * 单个工具调用卡片（非文件类）。
 *
 * - 头部：chevron + 工具名，点击展开/收起
 * - 展开后：两个可折叠子项 —— 「执行参数」（默认收起）与「结果」（默认展开，成功/失败标识）
 * - 例外（保持既有展示）：spawn_session / send_message_to_session 仍为 args 表格（结果走独立紫色摘要卡片）；
 *   ask_question 仍为 JSON args（结果走 AskQuestionCard）
 */
export interface ToolCallCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  /** 切换展开态；传 id 而非闭包，便于父级用 useCallback 稳定引用、让 memo 生效 */
  onToggle: (id: string) => void;
  running?: boolean;
  /** spawn_session 等工具的角色后缀，如 `worker` */
  roleSuffix?: string | null;
  /** 对应 tool result 的文本（卡片内「结果」子项内容） */
  resultContent?: string | null;
}

function ToolCallCard({
  msg,
  expanded,
  onToggle,
  running = false,
  roleSuffix = null,
  resultContent = null,
}: ToolCallCardProps) {
  const toolName = msg.tool_name || 'unknown';
  const { argsStr, parsedArgs } = useMemo(
    () => parseToolArgsJson(msg.tool_args_json),
    [msg.tool_args_json],
  );

  // 子项折叠态（组件内展示态）：执行参数默认收起、结果默认展开
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(true);
  // 每次重新展开卡片时恢复默认（参数收起 / 结果展开）
  useEffect(() => {
    if (expanded) {
      setArgsOpen(false);
      setResultOpen(true);
    }
  }, [expanded]);

  const showArgsTable =
    (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs !== null;
  // spawn/send_message 与 ask_question 保持既有展示（表格 / JSON args）
  const keepLegacyArgsOnly = showArgsTable || toolName === 'ask_question';

  const hasResult = resultContent !== null;
  const resultIsError = hasResult && isToolErrorMessage(resultContent);

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

            {expanded && (
              <div data-testid="tool-call-expanded" className="border-t border-amber-200 dark:border-amber-800">
                {keepLegacyArgsOnly && argsStr ? (
                  showArgsTable && parsedArgs ? (
                    <div className="px-3 py-2">
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
                    <div className="px-3 py-2">
                      <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                        {argsStr}
                      </pre>
                    </div>
                  )
                ) : (
                  <>
                    {/* 子项 1：执行参数（默认收起） */}
                    <div>
                      <button
                        type="button"
                        data-testid="tool-args-toggle"
                        onClick={() => setArgsOpen((v) => !v)}
                        className="w-full px-3 py-1.5 flex items-center gap-2 text-left cursor-pointer select-none hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
                      >
                        {argsOpen ? (
                          <ChevronDown className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                        )}
                        <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">
                          执行参数
                        </span>
                      </button>
                      {argsOpen && (
                        <div data-testid="tool-args-content" className="px-3 pb-2 pl-6">
                          {argsStr ? (
                            <pre className="text-[11px] text-amber-900 dark:text-amber-200 font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed">
                              {argsStr}
                            </pre>
                          ) : (
                            <div className="text-[10px] text-slate-400 dark:text-slate-500 italic">（无参数）</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 子项 2：结果（默认展开） */}
                    <div className="border-t border-amber-100 dark:border-amber-800/50">
                      <button
                        type="button"
                        data-testid="tool-result-toggle"
                        onClick={() => setResultOpen((v) => !v)}
                        className="w-full px-3 py-1.5 flex items-center gap-2 text-left cursor-pointer select-none hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
                      >
                        {resultOpen ? (
                          <ChevronDown className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                        ) : (
                          <ChevronRight className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
                        )}
                        <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-300">结果</span>
                        {hasResult ? (
                          resultIsError ? (
                            <span
                              data-testid="tool-result-status"
                              className="text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400"
                            >
                              失败
                            </span>
                          ) : (
                            <span
                              data-testid="tool-result-status"
                              className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400"
                            >
                              成功
                            </span>
                          )
                        ) : (
                          <span
                            data-testid="tool-result-status"
                            className="text-[10px] font-mono text-slate-400 dark:text-slate-500"
                          >
                            运行中
                          </span>
                        )}
                      </button>
                      {resultOpen && (
                        <div data-testid="tool-result-content">
                          {hasResult ? (
                            <ToolResultView content={resultContent} />
                          ) : (
                            <div className="px-3 py-2 text-[10px] text-slate-400 dark:text-slate-500 italic">
                              执行中…
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </>
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
