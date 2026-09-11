import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, LoaderCircle, Wrench } from 'lucide-react';
import ToolResultView from './ToolResultView';
import { isToolErrorMessage, parseToolArgsJson } from '../lib/tool-summary';

/**
 * 单个工具调用卡片（非文件类）。
 *
 * - 头部：chevron + 工具名（失败时附「失败」标识，折叠态可见），点击展开/收起
 * - 展开后：两个可折叠子项 —— 「执行参数」（默认收起）与「结果」（默认展开，成功/失败标识，可复制）
 * - 例外（保持既有展示）：spawn_session / send_message_to_session 仍为 args 表格（结果走独立摘要卡片）；
 *   ask_question 仍为 JSON args（结果走 AskQuestionCard）
 */
/** 卡片状态配色：成功绿 / 失败红 / 结果未回琥珀 */
const SCHEMES = {
  error: {
    card: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',
    cardHover: 'hover:bg-rose-100/40 dark:hover:bg-rose-900/20',
    accent: 'text-rose-600 dark:text-rose-400',
    key: 'text-rose-700 dark:text-rose-300',
    title: 'text-rose-800 dark:text-rose-300',
    content: 'text-rose-900 dark:text-rose-200',
    borderT: 'border-rose-200 dark:border-rose-800',
    borderSoft: 'border-rose-100 dark:border-rose-800/50',
    hover: 'hover:bg-rose-100/60 dark:hover:bg-rose-900/30',
  },
  pending: {
    card: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
    cardHover: 'hover:bg-amber-100/40 dark:hover:bg-amber-900/20',
    accent: 'text-amber-600 dark:text-amber-400',
    key: 'text-amber-700 dark:text-amber-300',
    title: 'text-amber-800 dark:text-amber-300',
    content: 'text-amber-900 dark:text-amber-200',
    borderT: 'border-amber-200 dark:border-amber-800',
    borderSoft: 'border-amber-100 dark:border-amber-800/50',
    hover: 'hover:bg-amber-100/60 dark:hover:bg-amber-900/30',
  },
  ok: {
    card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800',
    cardHover: 'hover:bg-emerald-100/40 dark:hover:bg-emerald-900/20',
    accent: 'text-emerald-600 dark:text-emerald-400',
    key: 'text-emerald-700 dark:text-emerald-300',
    title: 'text-emerald-800 dark:text-emerald-300',
    content: 'text-emerald-900 dark:text-emerald-200',
    borderT: 'border-emerald-200 dark:border-emerald-800',
    borderSoft: 'border-emerald-100 dark:border-emerald-800/50',
    hover: 'hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30',
  },
} as const;

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
  const [copiedResult, setCopiedResult] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 卸载时清理「已复制」复位定时器：避免组件卸载后 setState（也会污染测试的全局环境）
  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);
  // 每次重新展开卡片时恢复默认（参数收起 / 结果展开）：
  // 用 useLayoutEffect 在绘制前完成，避免快速收起再展开时闪现上一次的子项状态
  useLayoutEffect(() => {
    if (expanded) {
      setArgsOpen(false);
      setResultOpen(true);
    }
  }, [expanded]);

  const showArgsTable =
    (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs !== null;
  // spawn/send_message 与 ask_question 保持既有展示（args 表格 / JSON args），不显示「结果」子项
  // （其结果由独立卡片承载）；不依赖 argsStr，args 为空/非法时同样保持该布局
  const keepLegacyArgsOnly =
    toolName === 'spawn_session' || toolName === 'send_message_to_session' || toolName === 'ask_question';

  const hasResult = resultContent !== null;
  const resultIsError = hasResult && isToolErrorMessage(resultContent);
  // 卡片状态着色（与文件聚合卡片同口径）：失败红 / 结果未回琥珀 / 成功绿；
  // ask_question 是交互型工具（结果即用户答案），成功态保持中性琥珀，但失败仍按红色处理
  const cardStatus: 'error' | 'pending' | 'ok' = resultIsError ? 'error' : !hasResult ? 'pending' : 'ok';
  const status: 'error' | 'pending' | 'ok' =
    toolName === 'ask_question' && !resultIsError ? 'pending' : cardStatus;
  const scheme = SCHEMES[status];

  const handleCopyResult = () => {
    if (resultContent == null) return;
    try {
      // 剪贴板不可用（权限/非安全上下文/测试环境）时静默忽略
      void navigator.clipboard?.writeText(resultContent).catch(() => {});
    } catch {
      // navigator.clipboard 不存在时同步抛错
    }
    setCopiedResult(true);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      setCopiedResult(false);
      copyTimerRef.current = null;
    }, 1500);
  };

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div
            data-testid="tool-call-card"
            data-status={status}
            className={`border rounded-xl overflow-hidden transition-colors ${scheme.card} ${scheme.cardHover}`}
          >
            <div
              data-testid="tool-call-header"
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={() => onToggle(msg.id)}
            >
              {expanded ? (
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              ) : (
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              )}
              <Wrench className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              <span className={`text-xs font-semibold font-mono ${scheme.title}`}>
                {toolName}
                {roleSuffix ? ` (${roleSuffix})` : ''}
              </span>
              {resultIsError && (
                <span
                  data-testid="tool-call-error-badge"
                  className="text-[10px] font-mono font-bold text-rose-700 dark:text-rose-400 shrink-0"
                >
                  失败
                </span>
              )}
            </div>

            {expanded && (
              <div data-testid="tool-call-expanded" className={`border-t ${scheme.borderT}`}>
                {keepLegacyArgsOnly ? (
                  argsStr ? (
                    showArgsTable && parsedArgs ? (
                      <div className="px-3 py-2">
                        <table className="w-full text-[11px] font-mono leading-relaxed">
                          <tbody>
                            {Object.entries(parsedArgs).map(([key, value]) => (
                              <tr key={key} className={`border-b last:border-b-0 ${scheme.borderSoft}`}>
                                <td className={`font-semibold pr-3 py-1 align-top whitespace-nowrap ${scheme.key}`}>
                                  {key}
                                </td>
                                <td className={`py-1 break-words ${scheme.content}`}>
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
                        <pre className={`text-[11px] font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed ${scheme.content}`}>
                          {argsStr}
                        </pre>
                      </div>
                    )
                  ) : (
                    <div className="px-3 py-2 text-[10px] text-slate-400 dark:text-slate-500 italic">（无参数）</div>
                  )
                ) : (
                  <>
                    {/* 子项 1：执行参数（默认收起） */}
                    <div>
                      <button
                        type="button"
                        data-testid="tool-args-toggle"
                        onClick={() => setArgsOpen((v) => !v)}
                        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left cursor-pointer select-none ${scheme.hover}`}
                      >
                        {argsOpen ? (
                          <ChevronDown className={`w-3 h-3 shrink-0 ${scheme.accent}`} />
                        ) : (
                          <ChevronRight className={`w-3 h-3 shrink-0 ${scheme.accent}`} />
                        )}
                        <span className={`text-[11px] font-semibold ${scheme.title}`}>
                          执行参数
                        </span>
                      </button>
                      {argsOpen && (
                        <div data-testid="tool-args-content" className="px-3 pb-2 pl-6">
                          {argsStr ? (
                            <pre className={`text-[11px] font-mono whitespace-pre-wrap overflow-x-auto leading-relaxed ${scheme.content}`}>
                              {argsStr}
                            </pre>
                          ) : (
                            <div className="text-[10px] text-slate-400 dark:text-slate-500 italic">（无参数）</div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* 子项 2：结果（默认展开） */}
                    <div className={`border-t ${scheme.borderSoft}`}>
                      {/* 标题行用 div 承载点击（内部含复制按钮，避免 button 嵌套） */}
                      <div
                        data-testid="tool-result-toggle"
                        role="button"
                        tabIndex={0}
                        onClick={() => setResultOpen((v) => !v)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setResultOpen((v) => !v);
                          }
                        }}
                        className={`w-full px-3 py-1.5 flex items-center gap-2 text-left cursor-pointer select-none ${scheme.hover}`}
                      >
                        {resultOpen ? (
                          <ChevronDown className={`w-3 h-3 shrink-0 ${scheme.accent}`} />
                        ) : (
                          <ChevronRight className={`w-3 h-3 shrink-0 ${scheme.accent}`} />
                        )}
                        <span className={`text-[11px] font-semibold ${scheme.title}`}>结果</span>
                        {hasResult ? (
                          resultIsError ? (
                            <span
                              data-testid="tool-result-status"
                              className="text-[10px] font-mono font-bold text-rose-700 dark:text-rose-400"
                            >
                              失败
                            </span>
                          ) : (
                            <span
                              data-testid="tool-result-status"
                              className="text-[10px] font-mono font-bold text-emerald-700 dark:text-emerald-400"
                            >
                              成功
                            </span>
                          )
                        ) : (
                          <span
                            data-testid="tool-result-status"
                            className={`text-[10px] font-mono ${scheme.title}`}
                          >
                            运行中
                          </span>
                        )}
                        {hasResult && (
                          <button
                            type="button"
                            data-testid="tool-result-copy"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCopyResult();
                            }}
                            className="ml-auto text-[10px] font-mono text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer shrink-0"
                            title="复制结果"
                          >
                            {copiedResult ? '已复制' : '复制'}
                          </button>
                        )}
                      </div>
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
