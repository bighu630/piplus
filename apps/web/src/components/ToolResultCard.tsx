import React, { useMemo } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, Terminal } from 'lucide-react';
import MarkdownRenderer from './MarkdownRenderer';
import Collapse from './Collapse';
import { isToolErrorMessage } from '../lib/tool-summary';

/**
 * 独立结果卡片：`ask_question` 之外、结果不由工具调用卡片承载的结果消息。
 *
 * - `spawn_session` / `send_message_to_session`：结果 JSON 的 `summary` 走 Markdown 渲染（紫色卡），
 *   失败或无法解析时降级为普通结果文案（失败红 / 普通绿）
 * - 孤立结果（调用不在当前视图内，分页边界，任意工具）：普通结果文案
 * - **默认展开**，点击卡片头部收起/再展开（chevron 指示，键盘 Enter/Space 可达）
 *
 * 折叠态由调用方（TabChat）用「已收起 id 集合」受控维护，与 `ToolCallCard` 的展开态同一模式。
 */
export interface ToolResultCardProps {
  msg: ChatMessageDTO;
  expanded: boolean;
  /** 切换展开态；传 id 而非闭包，便于父级用 useCallback 稳定引用、让 memo 生效 */
  onToggle: (id: string) => void;
}

/** 非 summary 结果的摘要截断长度（与既有口径一致） */
const RESULT_SUMMARY_MAX_CHARS = 200;

interface ResultColorScheme {
  bg: string;
  border: string;
  borderT: string;
  icon: string;
  label: string;
  text: string;
  suffix: string;
  hover: string;
}

/** 结果卡片配色：失败红 / 子会话摘要紫 / 普通结果绿（与工具卡片同色系） */
const ERROR_SCHEME: ResultColorScheme = {
  bg: 'bg-rose-50 dark:bg-rose-950/30',
  border: 'border-rose-200 dark:border-rose-800',
  borderT: 'border-rose-200 dark:border-rose-800',
  icon: 'text-rose-600 dark:text-rose-400',
  label: 'text-rose-800 dark:text-rose-300',
  text: 'text-rose-900 dark:text-rose-200',
  suffix: 'text-rose-600/60 dark:text-rose-400/60',
  hover: 'hover:bg-rose-100/40 dark:hover:bg-rose-900/20',
};

const SPAWN_SCHEME: ResultColorScheme = {
  bg: 'bg-indigo-50 dark:bg-indigo-950/30',
  border: 'border-indigo-200 dark:border-indigo-800',
  borderT: 'border-indigo-200 dark:border-indigo-800',
  icon: 'text-indigo-600 dark:text-indigo-400',
  label: 'text-indigo-800 dark:text-indigo-300',
  text: 'text-indigo-900 dark:text-indigo-200',
  suffix: 'text-indigo-600/60 dark:text-indigo-400/60',
  hover: 'hover:bg-indigo-100/40 dark:hover:bg-indigo-900/20',
};

const PLAIN_SCHEME: ResultColorScheme = {
  bg: 'bg-emerald-50 dark:bg-emerald-950/30',
  border: 'border-emerald-200 dark:border-emerald-800',
  borderT: 'border-emerald-200 dark:border-emerald-800',
  icon: 'text-emerald-600 dark:text-emerald-400',
  label: 'text-emerald-800 dark:text-emerald-300',
  text: 'text-emerald-900 dark:text-emerald-200',
  suffix: 'text-emerald-600/60 dark:text-emerald-400/60',
  hover: 'hover:bg-emerald-100/40 dark:hover:bg-emerald-900/20',
};

/** spawn/send_message 结果 JSON 中的 summary/status（其余内容或失败结果返回 null，走普通文案） */
function parseSpawnSummary(
  toolName: string,
  contentText: string | null,
  isError: boolean,
): { summary: string; status: string | null } | null {
  if (toolName !== 'spawn_session' && toolName !== 'send_message_to_session') return null;
  if (!contentText || isError) return null;
  try {
    const parsed: unknown = JSON.parse(contentText);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      if (typeof record.summary === 'string' && record.summary.trim()) {
        return {
          summary: record.summary.trim(),
          status: typeof record.status === 'string' ? record.status : null,
        };
      }
    }
  } catch {
    // 不是 JSON：按普通结果渲染
  }
  return null;
}

function ToolResultCard({ msg, expanded, onToggle }: ToolResultCardProps) {
  const toolName = msg.tool_name || 'unknown';
  const contentText = msg.content_text ?? null;
  const isError = isToolErrorMessage(contentText);

  const spawn = useMemo(
    () => parseSpawnSummary(toolName, contentText, isError),
    [toolName, contentText, isError],
  );
  const spawnSummary = spawn?.summary ?? null;
  const spawnStatus = spawn?.status ?? null;
  const scheme = isError ? ERROR_SCHEME : spawnSummary ? SPAWN_SCHEME : PLAIN_SCHEME;

  // 正文口径与既有展示一致：非 summary 结果截断到 200 字（空内容不渲染正文）
  const summary = contentText && contentText.length > RESULT_SUMMARY_MAX_CHARS
    ? `${contentText.slice(0, RESULT_SUMMARY_MAX_CHARS)}…`
    : (contentText ?? '');

  // 头部状态文案：spawn 摘要显示完成状态，其余显示结果/错误
  const statusLabel = spawnSummary
    ? spawnStatus
      ? (spawnStatus === 'completed' ? '完成' : spawnStatus)
      : null
    : (isError ? '错误' : '结果');

  return (
    <div
      data-testid="standalone-result-card"
      className={`${scheme.bg} ${scheme.border} rounded-xl overflow-hidden`}
    >
      {/* 整行头部 = 收起/展开切换（与工具调用卡片交互一致） */}
      <div
        data-testid="standalone-result-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        className={`px-3 py-2 flex items-center gap-2 cursor-pointer select-none ${scheme.hover}`}
        onClick={() => onToggle(msg.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(msg.id);
          }
        }}
      >
        {expanded ? (
          <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${scheme.icon}`} />
        ) : (
          <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${scheme.icon}`} />
        )}
        <Terminal className={`w-3.5 h-3.5 ${scheme.icon} shrink-0`} />
        <span className={`text-xs font-semibold ${scheme.label} font-mono`}>
          {toolName}
        </span>
        {statusLabel && (
          <span data-testid="standalone-result-status" className={`text-[10px] ${scheme.suffix} ml-1`}>
            {statusLabel}
          </span>
        )}
      </div>

      {/* 高度展开/收起动画；收起时 AnimatePresence 在退出动画结束后卸载正文（Markdown/长文本不参与解析） */}
      <Collapse
        open={expanded && (Boolean(spawnSummary) || Boolean(contentText))}
        testId="standalone-result-body"
        className={`border-t ${scheme.borderT} ${spawnSummary ? 'px-4 py-3' : 'px-3 py-2'}`}
      >
        {spawnSummary ? (
          <div className="text-slate-800 dark:text-slate-200 w-full">
            <MarkdownRenderer content={spawnSummary} variant="compact" />
          </div>
        ) : contentText ? (
          <div className={`text-[11px] ${scheme.text} font-mono whitespace-pre-wrap leading-relaxed max-h-32 overflow-y-auto`}>
            {summary}
          </div>
        ) : null}
      </Collapse>
    </div>
  );
}

export default React.memo(ToolResultCard);
