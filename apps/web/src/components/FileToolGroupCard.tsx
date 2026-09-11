import React from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, FileCode, LoaderCircle, Wrench } from 'lucide-react';
import DiffViewer from './DiffViewer';
import ReadResultView from './ReadResultView';
import {
  findToolResultMessage,
  formatReadLineRange,
  parseToolArgsJson,
  parseWriteEditDiff,
  summarizeWriteEdit,
} from '../lib/tool-summary';

/**
 * 文件工具聚合卡片：同一条 assistant 消息内的 write/edit/read 调用以多行文件列表展示。
 * 交互：每行点击=独立展开该文件的明细；头部/「展开全部/收起全部」按钮=整组展开或收起（卡片级仅此一个总控）。
 */
export interface FileToolGroupCardProps {
  /** 同一 assistant 消息内的 write/edit/read 调用（长度 ≥ 1） */
  calls: ChatMessageDTO[];
  /** 全部消息：为每行查找对应 tool result（edit 精确 diff / read 内容） */
  messages: ChatMessageDTO[];
  /** 已独立展开的调用 id 集合 */
  expandedIds: Set<string>;
  onToggleOne: (id: string) => void;
  /** 卡片级总控：展开（expand=true）或收起组内全部文件 */
  onToggleAll: (ids: string[], expand: boolean) => void;
  /** 仍在运行的调用 id 集合 */
  runningIds: Set<string>;
}

const FileRow = React.memo(function FileRow({
  call,
  result,
  expanded,
  onToggle,
}: {
  call: ChatMessageDTO;
  result: ChatMessageDTO | null;
  expanded: boolean;
  onToggle: (id: string) => void;
}) {
  const toolName = call.tool_name || 'unknown';
  // 解析与统计按输入缓存：write 的 args 可能携带整份文件内容（几十~百 KB），
  // 流式期间 TabChat 频繁重渲染时不应每行重复 JSON.parse / LCS
  const { argsStr, parsedArgs } = React.useMemo(
    () => parseToolArgsJson(call.tool_args_json),
    [call.tool_args_json],
  );
  const writeEditSummary = React.useMemo(
    () => (parsedArgs ? summarizeWriteEdit(toolName, parsedArgs, result?.details) : null),
    [toolName, parsedArgs, result?.details],
  );
  const writeEditDiff = React.useMemo(
    () => (parsedArgs ? parseWriteEditDiff(toolName, parsedArgs) : null),
    [toolName, parsedArgs],
  );
  const readPath = toolName === 'read' && parsedArgs && typeof parsedArgs.path === 'string'
    ? parsedArgs.path
    : null;
  // 注：read 行号是「请求范围」而非文件实际内容范围（offset 超出文件尾时会偏大）
  const readLineRange = toolName === 'read' && parsedArgs ? formatReadLineRange(parsedArgs) : null;
  const readContent = toolName === 'read' ? result?.content_text ?? null : null;

  const path = writeEditSummary?.path ?? readPath ?? null;

  return (
    <div>
      <div
        data-testid="tool-file-row"
        className="px-3 py-1.5 flex items-center gap-2 min-w-0 cursor-pointer hover:bg-amber-100/60 dark:hover:bg-amber-900/30"
        onClick={() => onToggle(call.id)}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-amber-600 dark:text-amber-400 shrink-0" />
        )}
        <FileCode className="w-3.5 h-3.5 text-amber-600/80 dark:text-amber-400/80 shrink-0" />
        <span
          className="text-[11px] font-mono text-amber-800 dark:text-amber-300 truncate max-w-[300px]"
          title={path ?? undefined}
        >
          {path ?? '(未提供路径)'}
        </span>
        {writeEditSummary && (
          <>
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
        )}
        {readLineRange && (
          <span
            data-testid="tool-call-line-range"
            className="text-[10px] font-mono font-bold text-amber-700 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-900/50 rounded px-1 py-px shrink-0"
          >
            {readLineRange}
          </span>
        )}
      </div>

      {expanded && (
        <div data-testid="tool-file-detail">
          {writeEditDiff && (toolName === 'write' || toolName === 'edit') ? (
            <DiffViewer
              oldText={writeEditDiff.oldText}
              newText={writeEditDiff.newText}
              viewType={toolName === 'write' ? 'write' : 'edit'}
            />
          ) : readContent !== null ? (
            <ReadResultView content={readContent} />
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
  );
});

function FileToolGroupCard({
  calls,
  messages,
  expandedIds,
  onToggleOne,
  onToggleAll,
  runningIds,
}: FileToolGroupCardProps) {
  const ids = calls.map((c) => c.id);
  const allExpanded = ids.length > 0 && ids.every((id) => expandedIds.has(id));
  const anyRunning = ids.some((id) => runningIds.has(id));
  const toolNames = [...new Set(calls.map((c) => c.tool_name || 'unknown'))];
  const label = `${toolNames.join(' + ')}${calls.length > 1 ? ` × ${calls.length}` : ''}`;

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-xl overflow-hidden transition-colors hover:bg-amber-100/80 dark:hover:bg-amber-900/40">
            <div
              data-testid="tool-group-header"
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={() => onToggleAll(ids, !allExpanded)}
            >
              {allExpanded ? (
                <ChevronDown className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              ) : (
                <ChevronRight className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              )}
              <Wrench className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-xs font-semibold text-amber-800 dark:text-amber-300 font-mono">
                {label}
              </span>
              <button
                type="button"
                onClick={(e) => {
                  // 头部整行可点击，避免按钮冒泡后双重切换
                  e.stopPropagation();
                  onToggleAll(ids, !allExpanded);
                }}
                className="ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-900/40 hover:bg-amber-200/70 dark:hover:bg-amber-800/50 transition-colors cursor-pointer shrink-0"
              >
                {allExpanded ? '收起全部' : '展开全部'}
              </button>
            </div>

            {calls.map((call) => (
              <FileRow
                key={call.id}
                call={call}
                result={findToolResultMessage(messages, call.id, call.tool_name || 'unknown', call.tool_call_id)}
                expanded={expandedIds.has(call.id)}
                onToggle={onToggleOne}
              />
            ))}
          </div>
          {anyRunning && (
            <div className="ml-2 pt-2 shrink-0">
              <LoaderCircle className="w-4 h-4 text-indigo-500 animate-spin" />
            </div>
          )}
        </div>
        <span className="text-[10px] text-slate-400 dark:text-slate-500 mt-1 px-1 font-mono">
          {new Date(calls[0].created_at).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

export default FileToolGroupCard;
