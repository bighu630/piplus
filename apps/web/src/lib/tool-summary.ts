import type { ChatMessageDTO } from '@piplus/shared';
import { computeLineDiff } from './diff';

/**
 * write/edit/read 的 tool call 摘要提取（纯函数，无 React 依赖）。
 *
 * 数据来源（已核实 pi 0.85 工具实现）：
 * - write：args = { path, content }，结果 details 为空 → 只能统计 +N（新增行数）
 * - edit：args = { path, edits: [{ oldText, newText }] }，结果 details.diff 为带行号前缀的
 *   `+N text` / `-N text` 行（context 行可能被裁剪，增删行完整）→ 精确 +N -N，缺失时回退 args
 * - read：args = { path, offset, limit } → 行号范围按参数推导
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 行数统计：空文本为 0 行；末尾换行不额外计一行（与 pi 截断逻辑的行数口径一致）。 */
export function splitLineCount(text: string): number {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export interface WriteEditDiff {
  path: string | null;
  oldText?: string;
  newText: string;
}

/**
 * 从 write/edit 的 tool call args 解析文件路径与用于 diff 展示的旧/新文本。
 * 无法识别时返回 null（调用方降级为原始 args 文本）。
 */
export function parseWriteEditDiff(
  toolName: string,
  args: Record<string, unknown>,
): WriteEditDiff | null {
  if (toolName === 'write') {
    const path = typeof args.path === 'string' ? args.path : null;
    const content = typeof args.content === 'string' ? args.content : '';
    return { path, newText: content };
  }

  if (toolName === 'edit') {
    const path = typeof args.path === 'string' ? args.path : null;
    const edits = args.edits;
    if (Array.isArray(edits) && edits.length > 0) {
      // 合并所有 edits 为单份 diff 视图（与历史行为一致）
      const oldParts: string[] = [];
      const newParts: string[] = [];
      for (const edit of edits) {
        const e = asRecord(edit);
        if (!e) continue;
        if (typeof e.oldText === 'string') oldParts.push(e.oldText);
        if (typeof e.newText === 'string') newParts.push(e.newText);
      }
      if (newParts.length > 0) {
        return { path, oldText: oldParts.join('\n'), newText: newParts.join('\n') };
      }
    }
    // 兼容单条 oldText/newText 直传形式
    if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
      return { path, oldText: args.oldText, newText: args.newText };
    }
    return null;
  }

  return null;
}

/** 数 details.diff 中的 `+` / `-` 行（格式 `+123 text`，context 行为空格前缀，不会误计）。 */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

function extractDetailsDiff(details: unknown): string | null {
  const record = asRecord(details);
  if (!record) return null;
  return typeof record.diff === 'string' ? record.diff : null;
}

/** 回退统计：逐条 edit 独立做行级 diff 后累加（拼接后在段间会引入伪差异）。 */
function countEditArgsLines(args: Record<string, unknown>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  const edits = Array.isArray(args.edits) ? args.edits : [];
  let counted = false;
  for (const edit of edits) {
    const e = asRecord(edit);
    if (!e || typeof e.newText !== 'string') continue;
    counted = true;
    const oldText = typeof e.oldText === 'string' ? e.oldText : '';
    for (const line of computeLineDiff(oldText, e.newText)) {
      if (line.type === 'add') added++;
      else if (line.type === 'delete') removed++;
    }
  }
  if (counted) return { added, removed };

  if (typeof args.oldText === 'string' && typeof args.newText === 'string') {
    for (const line of computeLineDiff(args.oldText, args.newText)) {
      if (line.type === 'add') added++;
      else if (line.type === 'delete') removed++;
    }
  }
  return { added, removed };
}

export interface WriteEditSummary {
  path: string | null;
  added: number;
  removed: number;
}

/**
 * write/edit 卡片头部摘要：文件路径 + 增删行数。
 * - write：added = content 行数，removed 恒为 0（pi 不返回旧内容）
 * - edit：优先取结果 details.diff 的精确统计，缺失时回退 args 行级 diff
 * 非 write/edit 或 args 无法解析时返回 null。
 */
export function summarizeWriteEdit(
  toolName: string,
  args: Record<string, unknown>,
  details?: unknown,
): WriteEditSummary | null {
  const parsed = parseWriteEditDiff(toolName, args);
  if (!parsed) return null;

  if (toolName === 'write') {
    return { path: parsed.path, added: splitLineCount(parsed.newText), removed: 0 };
  }

  const diffText = extractDetailsDiff(details);
  if (diffText !== null) {
    const counted = countDiffLines(diffText);
    if (counted.added > 0 || counted.removed > 0) {
      return { path: parsed.path, ...counted };
    }
  }

  return { path: parsed.path, ...countEditArgsLines(args) };
}

/**
 * read 卡片的行号范围文案，按 args 推导（limit 为行数，范围含端点）：
 * - offset + limit → `100-149`
 * - 仅 offset → `100+`
 * - 仅 limit → `1-50`
 * - 都没有 → null（不显示行号部分）
 *
 * 注：展示的是请求范围而非文件实际内容范围（offset 超出文件尾或文件更短时会偏大）；
 * 实际范围仅在 pi 结果文本的 `[Showing lines X-Y of Z]` 中出现，不保证存在。
 */
export function formatReadLineRange(args: Record<string, unknown>): string | null {
  const offset = toPositiveInt(args.offset);
  const limit = toPositiveInt(args.limit);
  if (offset !== null && limit !== null) return `${offset}-${offset + limit - 1}`;
  if (offset !== null) return `${offset}+`;
  if (limit !== null) return `1-${limit}`;
  return null;
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const int = Math.floor(value);
  return int >= 1 ? int : null;
}

/**
 * 在消息序列中查找 tool_call 之后第一条同名工具的 result 消息
 * （与 isToolCallPending 的匹配口径一致，用于取 edit 的 details 精确 diff）。
 *
 * 局限：DTO 未暴露 toolCallId，只能按 tool_name 顺序匹配；若某次调用的 result
 * 缺失（被中断/未落盘），后续同名工具的 result 可能被挂到较前的卡片上。
 */
export function findToolResultMessage(
  messages: ChatMessageDTO[],
  msgId: string,
  toolName: string,
): ChatMessageDTO | null {
  const msgIndex = messages.findIndex((m) => m.id === msgId);
  if (msgIndex === -1) return null;
  for (let i = msgIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if ((m.message_kind === 'tool' || m.role === 'tool') && m.tool_name && m.tool_name === toolName) {
      return m;
    }
  }
  return null;
}
