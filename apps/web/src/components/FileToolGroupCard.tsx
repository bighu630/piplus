import React, { useCallback, useState } from 'react';
import type { ChatMessageDTO } from '@piplus/shared';
import { ChevronDown, ChevronRight, FileCode, LoaderCircle, Wrench } from 'lucide-react';
import DiffViewer from './DiffViewer';
import ReadResultView from './ReadResultView';
import {
  findToolResultMessage,
  formatReadLineRange,
  isToolErrorMessage,
  parseToolArgsJson,
  parseWriteEditDiff,
  summarizeWriteEdit,
} from '../lib/tool-summary';

/**
 * 文件工具聚合卡片：同一条 assistant 消息内的 write/edit/read 调用以多行文件列表展示。
 *
 * 交互：
 * - 每行点击 = 独立展开/收起该文件的明细；失败行的失败原因默认展开（点击可收起）
 * - 头部与卡片级唯一的「展开全部/收起全部」按钮 = 整组展开/收起
 *
 * 状态着色（工具调用视为一个整体）：
 * - 全部成功 → 绿色卡片；有任一失败 → 红色卡片（失败行额外标红便于定位）
 * - 仍在运行（结果未回）→ 保持琥珀色
 */
export interface FileToolGroupCardProps {
  /** 同一 assistant 消息内的 write/edit/read 调用（长度 ≥ 1） */
  calls: ChatMessageDTO[];
  /** 全部消息：为每行查找对应 tool result（edit 精确 diff / read 内容 / 失败原因） */
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
  status,
  onToggle,
}: {
  call: ChatMessageDTO;
  result: ChatMessageDTO | null;
  expanded: boolean;
  /** error=失败；pending=结果未回（运行中/被中断/未落盘）；ok=成功 */
  status: 'error' | 'pending' | 'ok';
  onToggle: (id: string, status: 'error' | 'pending' | 'ok') => void;
}) {
  const toolName = call.tool_name || 'unknown';
  const isError = status === 'error';
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
    () => (parsedArgs && !isError ? parseWriteEditDiff(toolName, parsedArgs) : null),
    [toolName, parsedArgs, isError],
  );
  const readPath = toolName === 'read' && parsedArgs && typeof parsedArgs.path === 'string'
    ? parsedArgs.path
    : null;
  // 注：read 行号是「请求范围」而非文件实际内容范围（offset 超出文件尾时会偏大）
  const readLineRange = toolName === 'read' && parsedArgs ? formatReadLineRange(parsedArgs) : null;
  const readContent = toolName === 'read' && !isError ? result?.content_text ?? null : null;

  const path = writeEditSummary?.path ?? readPath ?? null;
  const tone = status === 'error'
    ? 'text-rose-700 dark:text-rose-400'
    : status === 'pending'
      ? 'text-amber-800 dark:text-amber-300'
      : 'text-emerald-800 dark:text-emerald-300';
  const iconTone = status === 'error'
    ? 'text-rose-600 dark:text-rose-400'
    : status === 'pending'
      ? 'text-amber-600 dark:text-amber-400'
      : 'text-emerald-600 dark:text-emerald-400';
  const hoverTone = status === 'error'
    ? 'hover:bg-rose-100/60 dark:hover:bg-rose-900/30'
    : status === 'pending'
      ? 'hover:bg-amber-100/60 dark:hover:bg-amber-900/30'
      : 'hover:bg-emerald-100/60 dark:hover:bg-emerald-900/30';

  return (
    <div>
      <div
        data-testid="tool-file-row"
        data-status={status}
        className={`px-3 py-1.5 flex items-center gap-2 min-w-0 cursor-pointer ${hoverTone}`}
        onClick={() => onToggle(call.id, status)}
      >
        {expanded ? (
          <ChevronDown className={`w-3 h-3 shrink-0 ${iconTone}`} />
        ) : (
          <ChevronRight className={`w-3 h-3 shrink-0 ${iconTone}`} />
        )}
        <FileCode className={`w-3.5 h-3.5 shrink-0 ${iconTone}`} />
        <span
          className={`text-[11px] font-mono truncate max-w-[300px] ${tone}`}
          title={path ?? undefined}
        >
          {path ?? '(未提供路径)'}
        </span>
        {writeEditSummary && !isError && (
          <>
            {(writeEditSummary.added > 0 || writeEditSummary.removed === 0) && (
              <span className="text-[10px] font-mono font-bold text-emerald-600 dark:text-emerald-400 shrink-0">
                +{writeEditSummary.added}
              </span>
            )}
            {writeEditSummary.removed > 0 && (
              <span className="text-[10px] font-mono font-bold text-rose-700 dark:text-rose-400 shrink-0">
                -{writeEditSummary.removed}
              </span>
            )}
          </>
        )}
        {readLineRange && !isError && (
          <span
            data-testid="tool-call-line-range"
            className="text-[10px] font-mono font-bold text-amber-700 dark:text-amber-300 bg-amber-100/80 dark:bg-amber-900/50 rounded px-1 py-px shrink-0"
          >
            {readLineRange}
          </span>
        )}
        {isError && (
          <span className="text-[10px] font-mono font-bold text-rose-700 dark:text-rose-400 shrink-0">
            失败
          </span>
        )}
      </div>

      {expanded && (
        <div data-testid="tool-file-detail">
          {isError && result ? (
            <div className="border-t border-rose-200 dark:border-rose-800 bg-rose-50/50 dark:bg-rose-950/20 px-3 py-2">
              <pre className="text-[11px] font-mono whitespace-pre-wrap break-all leading-relaxed text-rose-700 dark:text-rose-400">
                {result.content_text}
              </pre>
            </div>
          ) : writeEditDiff && (toolName === 'write' || toolName === 'edit') ? (
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
  // 失败原因默认展开；用户点击失败行可收起（纯展示态，无需提升到父级）
  const [collapsedErrorIds, setCollapsedErrorIds] = useState<Set<string>>(new Set());

  const rows = calls.map((call) => {
    const result = findToolResultMessage(messages, call.id, call.tool_name || 'unknown', call.tool_call_id);
    return {
      call,
      result,
      isError: result !== null && isToolErrorMessage(result.content_text),
      hasResult: result !== null,
    };
  });

  const ids = calls.map((c) => c.id);
  const hasError = rows.some((r) => r.isError);
  // 结果未回（运行中/被中断/未落盘）时归为 pending，不宣称为成功
  const hasPending = rows.some((r) => !r.hasResult);
  const anyRunning = ids.some((id) => runningIds.has(id));
  const cardStatus: 'error' | 'pending' | 'ok' = hasError ? 'error' : hasPending ? 'pending' : 'ok';
  const rowStatus = (row: { isError: boolean; hasResult: boolean }): 'error' | 'pending' | 'ok' =>
    row.isError ? 'error' : row.hasResult ? 'ok' : 'pending';
  const isRowExpanded = (id: string, status: 'error' | 'pending' | 'ok') =>
    status === 'error' ? !collapsedErrorIds.has(id) : expandedIds.has(id);
  const allExpanded = rows.length > 0 && rows.every((r) => isRowExpanded(r.call.id, rowStatus(r)));

  const toolNames = [...new Set(calls.map((c) => c.tool_name || 'unknown'))];
  const label = `${toolNames.join(' + ')}${calls.length > 1 ? ` × ${calls.length}` : ''}`;

  const scheme = cardStatus === 'error'
    ? {
        card: 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800',
        accent: 'text-rose-600 dark:text-rose-400',
        title: 'text-rose-800 dark:text-rose-300',
      }
    : cardStatus === 'pending'
      ? {
          card: 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800',
          accent: 'text-amber-600 dark:text-amber-400',
          title: 'text-amber-800 dark:text-amber-300',
        }
      : {
          card: 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-800',
          accent: 'text-emerald-600 dark:text-emerald-400',
          title: 'text-emerald-800 dark:text-emerald-300',
        };

  const toggleAll = (expand: boolean) => {
    if (expand) {
      setCollapsedErrorIds(new Set());
      onToggleAll(ids, true);
    } else {
      // 收起全部：失败行也一并收起（否则它们会因“默认展开”规则再次出现）
      setCollapsedErrorIds(new Set(rows.filter((r) => r.isError).map((r) => r.call.id)));
      onToggleAll(ids, false);
    }
  };

  // 稳定引用：保持 FileRow 的 React.memo 生效（否则流式重渲染时每行都会重算解析）
  const toggleOne = useCallback((id: string, status: 'error' | 'pending' | 'ok') => {
    if (status !== 'error') {
      onToggleOne(id);
      return;
    }
    setCollapsedErrorIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [onToggleOne]);

  return (
    <div className="flex justify-start items-start w-full min-w-0">
      <div className="flex flex-col items-start max-w-full flex-1 min-w-0">
        <div className="flex items-start min-w-0">
          <div
            data-testid="tool-group-card"
            data-status={cardStatus}
            className={`border rounded-xl overflow-hidden transition-colors ${scheme.card}`}
          >
            <div
              data-testid="tool-group-header"
              className="px-3 py-2 flex items-center gap-2 cursor-pointer select-none"
              onClick={() => toggleAll(!allExpanded)}
            >
              {allExpanded ? (
                <ChevronDown className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              ) : (
                <ChevronRight className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              )}
              <Wrench className={`w-3.5 h-3.5 shrink-0 ${scheme.accent}`} />
              <span className={`text-xs font-semibold font-mono ${scheme.title}`}>{label}</span>
              {hasError && (
                <span className="text-[10px] font-mono font-bold text-rose-700 dark:text-rose-400 shrink-0">
                  失败
                </span>
              )}
              <button
                type="button"
                onClick={(e) => {
                  // 头部整行可点击，避免按钮冒泡后双重切换
                  e.stopPropagation();
                  toggleAll(!allExpanded);
                }}
                className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer shrink-0 ${
                  cardStatus === 'error'
                    ? 'text-rose-700 dark:text-rose-300 bg-rose-100/70 dark:bg-rose-900/40 hover:bg-rose-200/70 dark:hover:bg-rose-800/50'
                    : cardStatus === 'pending'
                      ? 'text-amber-700 dark:text-amber-300 bg-amber-100/70 dark:bg-amber-900/40 hover:bg-amber-200/70 dark:hover:bg-amber-800/50'
                      : 'text-emerald-700 dark:text-emerald-300 bg-emerald-100/70 dark:bg-emerald-900/40 hover:bg-emerald-200/70 dark:hover:bg-emerald-800/50'
                }`}
              >
                {allExpanded ? '收起全部' : '展开全部'}
              </button>
            </div>

            {rows.map((row) => (
              <FileRow
                key={row.call.id}
                call={row.call}
                result={row.result}
                status={rowStatus(row)}
                expanded={isRowExpanded(row.call.id, rowStatus(row))}
                onToggle={toggleOne}
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
