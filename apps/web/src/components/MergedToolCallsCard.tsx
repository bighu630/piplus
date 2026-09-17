import React from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, Wrench } from 'lucide-react';
import ToolCallBody from './ToolCallBody';
import { findToolResultMessage } from '../lib/tool-summary';
import { TOOL_CALL_SCHEMES } from '../lib/tool-call-scheme';

/**
 * 合并的工具调用卡片：连续相邻、同一工具、成功的多次调用合并展示。
 *
 * - 头部：chevron + 工具名 + `×N`（调用次数），点击展开/收起整组
 * - 展开后：每个调用一组「执行参数（默认收起）+ 结果（默认展开）」，组间以分割线隔开
 * - 合并组只包含成功调用 → 恒为成功（绿色）配色；失败调用由 ToolCallCard 单独渲染
 *   （因此不存在「运行中」态，无需 spinner）
 */
export interface MergedToolCallsCardProps {
  toolName: string;
  calls: ChatMessageDTO[];
  /** 全部消息：为每个调用查找对应结果 */
  messages: ChatMessageDTO[];
  expanded: boolean;
  onToggle: (id: string) => void;
  /**
   * 时间戳文本：`undefined` = 默认渲染 `calls[0].created_at`；`null` = 隐藏。
   * 「隐藏对话框时间戳」开启且组内不含会话首尾消息时由 TabChat 传入 null。
   */
  timestamp?: string | null;
}

function MergedToolCallsCard({ toolName, calls, messages, expanded, onToggle, timestamp }: MergedToolCallsCardProps) {
  const scheme = TOOL_CALL_SCHEMES.ok;
  const anchor = calls[0];

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div
            data-testid="merged-tool-card"
            data-status="ok"
            className={`border rounded-xl overflow-hidden transition-colors ${scheme.card} ${scheme.cardHover}`}
          >
            <div
              data-testid="merged-tool-header"
              role="button"
              tabIndex={0}
              aria-expanded={expanded}
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={() => onToggle(anchor.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onToggle(anchor.id);
                }
              }}
            >
              {expanded ? (
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              ) : (
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              )}
              <Wrench className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              <span className={`text-xs font-semibold font-mono ${scheme.title}`}>{toolName}</span>
              <span
                data-testid="merged-tool-count"
                className={`text-[10px] font-mono font-bold rounded px-1 py-px shrink-0 ${scheme.badge}`}
              >
                ×{calls.length}
              </span>
            </div>

            {/* 条件挂载：重新展开时子项状态自动恢复默认 */}
            {expanded &&
              calls.map((call, index) => (
                <div
                  key={call.id}
                  data-testid="merged-tool-entry"
                  className={`border-t ${scheme.borderT}${index > 0 ? ' mt-1' : ''}`}
                >
                  <ToolCallBody
                    call={call}
                    resultContent={
                      findToolResultMessage(messages, call.id, call.tool_name || 'unknown', call.tool_call_id)
                        ?.content_text ?? null
                    }
                    scheme={scheme}
                  />
                </div>
              ))}
          </div>
        </div>
        {timestamp !== null && (
          <span data-testid="message-timestamp" className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1 font-mono">
            {new Date(timestamp ?? anchor.created_at).toLocaleTimeString()}
          </span>
        )}
      </div>
    </div>
  );
}

export default MergedToolCallsCard;
