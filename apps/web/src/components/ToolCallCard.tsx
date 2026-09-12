import React from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, LoaderCircle, Wrench } from 'lucide-react';
import ToolCallBody from './ToolCallBody';
import { isToolErrorMessage } from '../lib/tool-summary';
import { TOOL_CALL_SCHEMES, type ToolCallStatus } from '../lib/tool-call-scheme';

/**
 * 单个工具调用卡片（非文件类、未参与合并的调用）。
 *
 * - 头部：chevron + 工具名（失败时附「失败」标识，折叠态可见），点击展开/收起
 * - 展开后：`ToolCallBody`（「执行参数」默认收起 / 「结果」默认展开；bash 参数为表格 + 命令高亮）
 * - 卡片按状态着色：失败红 / 结果未回琥珀 / 成功绿（`ask_question` 成功态保持琥珀，失败仍红）
 *
 * 连续相邻、同一工具、成功的调用由 `MergedToolCallsCard` 合并展示（见 TabChat）。
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

  const hasResult = resultContent !== null;
  const resultIsError = hasResult && isToolErrorMessage(resultContent);
  // 卡片状态着色（与文件聚合卡片同口径）：失败红 / 结果未回琥珀 / 成功绿；
  // ask_question 是交互型工具（结果即用户答案），成功态保持中性琥珀，但失败仍按红色处理
  const cardStatus: ToolCallStatus = resultIsError ? 'error' : !hasResult ? 'pending' : 'ok';
  const status: ToolCallStatus =
    toolName === 'ask_question' && !resultIsError ? 'pending' : cardStatus;
  const scheme = TOOL_CALL_SCHEMES[status];

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
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={() => onToggle(msg.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(msg.id);
                }
              }}
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

            {/* 条件挂载：重新展开时子项状态自动恢复默认（参数收起 / 结果展开） */}
            {expanded && (
              <div data-testid="tool-call-expanded" className={`border-t ${scheme.borderT}`}>
                <ToolCallBody call={msg} resultContent={resultContent} scheme={scheme} />
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
