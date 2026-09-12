import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight } from 'lucide-react';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import ToolResultView from './ToolResultView';
import { formatBashCommand } from '../lib/format-bash-command';
import { isToolErrorMessage, parseToolArgsJson } from '../lib/tool-summary';
import type { ToolCallScheme } from '../lib/tool-call-scheme';

// 只注册 bash 语言（工具参数里的命令高亮）；显式依赖 lib/core + bash，避免绑定全量语言包
hljs.registerLanguage('bash', bash);

/** 复制到剪贴板并短暂显示「已复制」；卸载时清理复位定时器（避免卸载后 setState） */
function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
  }, []);
  const copy = (text: string | null | undefined) => {
    if (text == null) return;
    try {
      // 剪贴板不可用（权限/非安全上下文/测试环境）时静默忽略
      void navigator.clipboard?.writeText(text).catch(() => {});
    } catch {
      // navigator.clipboard 不存在时同步抛错
    }
    setCopied(true);
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setCopied(false);
      timerRef.current = null;
    }, resetMs);
  };
  return { copied, copy };
}

/**
 * 单个工具调用的「展开区主体」：两个可折叠子项 —— 「执行参数」（默认收起）与「结果」（默认展开）。
 *
 * - bash：参数为**表格**（命令断行缩进 + 语法高亮，右上角「复制命令」复制原始命令）
 * - 其它工具：参数为 JSON 原文
 * - spawn_session / send_message_to_session / ask_question：保持既有 args 展示（表格 / JSON），不显示结果子项
 *
 * 子项折叠态由本组件内部维护：调用方通过条件挂载（`{expanded && <ToolCallBody/>}`）在重新展开时恢复默认。
 */
export interface ToolCallBodyProps {
  call: ChatMessageDTO;
  resultContent: string | null;
  scheme: ToolCallScheme;
}

function ToolCallBody({ call, resultContent, scheme }: ToolCallBodyProps) {
  const toolName = call.tool_name || 'unknown';
  const { argsStr, parsedArgs } = useMemo(
    () => parseToolArgsJson(call.tool_args_json),
    [call.tool_args_json],
  );

  // 子项折叠态：执行参数默认收起、结果默认展开
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(true);
  const resultCopy = useCopyToClipboard();
  const commandCopy = useCopyToClipboard();

  const showArgsTable =
    (toolName === 'spawn_session' || toolName === 'send_message_to_session') && parsedArgs !== null;
  // spawn/send_message 与 ask_question 保持既有展示，不显示「结果」子项（结果由独立卡片承载）
  const keepLegacyArgsOnly =
    toolName === 'spawn_session' || toolName === 'send_message_to_session' || toolName === 'ask_question';

  const hasResult = resultContent !== null;
  const resultIsError = hasResult && isToolErrorMessage(resultContent);

  // bash：命令格式化 + 语法高亮（仅在参数子项展开时计算：命令可能数十 KB）
  const bashCommand = useMemo(() => {
    if (!argsOpen || toolName !== 'bash' || !parsedArgs || typeof parsedArgs.command !== 'string') return null;
    const raw = parsedArgs.command;
    const formatted = formatBashCommand(raw);
    try {
      return { raw, formatted, html: hljs.highlight(formatted, { language: 'bash' }).value };
    } catch {
      return { raw, formatted, html: null };
    }
  }, [argsOpen, toolName, parsedArgs]);

  return (
    <div data-testid="tool-call-body" className="min-w-0">
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
              <span className={`text-[11px] font-semibold ${scheme.title}`}>执行参数</span>
            </button>
            {argsOpen && (
              <div data-testid="tool-args-content" className="px-3 pb-2 pl-6">
                {toolName === 'bash' && parsedArgs ? (
                  <>
                    <div className="flex items-center justify-end mb-1 h-4">
                      {bashCommand && (
                        <button
                          type="button"
                          data-testid="bash-command-copy"
                          onClick={() => commandCopy.copy(bashCommand.raw)}
                          className="text-[10px] font-mono text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer"
                          title="复制原始命令（可直接执行）"
                        >
                          {commandCopy.copied ? '已复制' : '复制命令'}
                        </button>
                      )}
                    </div>
                    <table data-testid="bash-args-table" className="w-full text-[11px] font-mono leading-relaxed">
                      <tbody>
                        {Object.entries(parsedArgs).map(([key, value]) => (
                          <tr key={key} className={`border-b last:border-b-0 ${scheme.borderSoft}`}>
                            <td className={`font-semibold pr-3 py-1 align-top whitespace-nowrap ${scheme.key}`}>
                              {key}
                            </td>
                            <td className={`py-1 align-top break-words ${scheme.content}`}>
                              {key === 'command' && bashCommand ? (
                                <pre className="whitespace-pre overflow-x-auto">
                                  {bashCommand.html ? (
                                    <code dangerouslySetInnerHTML={{ __html: bashCommand.html }} />
                                  ) : (
                                    bashCommand.formatted
                                  )}
                                </pre>
                              ) : typeof value === 'object' && value !== null ? (
                                JSON.stringify(value)
                              ) : (
                                String(value)
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : argsStr ? (
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
                    resultCopy.copy(resultContent);
                  }}
                  className="ml-auto text-[10px] font-mono text-slate-400 dark:text-slate-500 hover:text-slate-600 dark:hover:text-slate-300 cursor-pointer shrink-0"
                  title="复制结果"
                >
                  {resultCopy.copied ? '已复制' : '复制'}
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
  );
}

export default React.memo(ToolCallBody);
