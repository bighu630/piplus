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
 * 在消息序列中查找 tool_call 对应的 tool result。
 *
 * 优先按 toolCallId 精确匹配（pi 历史的 call/result 都带 id，同轮多次同名调用不会错配）；
 * 无 id（旧会话 / 分页缺字段）时回退「第 k 个同名调用 ↔ 第 k 个同名结果」序数配对，
 * 结果条数不足时返回 null（调用方降级为 args 展示）。
 */
export function findToolResultMessage(
  messages: ChatMessageDTO[],
  msgId: string,
  toolName: string,
  toolCallId?: string | null,
): ChatMessageDTO | null {
  const isSameToolResult = (m: ChatMessageDTO) =>
    (m.message_kind === 'tool' || m.role === 'tool') && m.tool_name === toolName;

  // 优先按 toolCallId 精确匹配（pi 历史的 call/result 都带 id）；未命中（结果侧缺 id 等）继续序数回退
  if (toolCallId) {
    const matched = messages.find((m) => isSameToolResult(m) && m.tool_call_id === toolCallId);
    if (matched) return matched;
  }

  const msgIndex = messages.findIndex((m) => m.id === msgId);
  if (msgIndex === -1) return null;

  // 该调用是同名调用中的第几个（全局名次）
  let callOrdinal = 0;
  for (let i = 0; i <= msgIndex; i++) {
    const m = messages[i];
    if (m.message_kind === 'tool_call' && m.tool_name === toolName) callOrdinal++;
  }

  // 从数组头累计已出现的同名结果，使「第 k 个调用 ↔ 第 k 个结果」在交错顺序（c1,r1,c2,r2）下也成立
  let seenResults = 0;
  for (let i = 0; i < msgIndex; i++) {
    if (isSameToolResult(messages[i])) seenResults++;
  }
  for (let i = msgIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (!isSameToolResult(m)) continue;
    seenResults++;
    if (seenResults === callOrdinal) return m;
  }
  return null;
}

/** write/edit/read：会与文件交互、需要聚合展示的三类工具调用 */
export function isFileToolCall(msg: ChatMessageDTO): boolean {
  return msg.message_kind === 'tool_call'
    && (msg.tool_name === 'write' || msg.tool_name === 'edit' || msg.tool_name === 'read');
}

/** 从 tool_call 消息 id 还原所属 assistant 消息 id（pi-client history 生成规则：`${entryId}-tool-${i}`） */
export function assistantEntryId(msgId: string): string {
  return msgId.replace(/-tool-\d+$/, '');
}

export interface FileToolGroup {
  /** 组内第一条调用的 id：既作组 id，也决定该组在消息流中的渲染位置 */
  id: string;
  calls: ChatMessageDTO[];
}

/**
 * 把「同一条 assistant 消息内的 write/edit/read 调用」聚合为组：
 * 同一回合的多次文件操作在一张卡片里以多行文件列表展示（每行可独立展开，卡片级只有一个总控按钮）。
 * 调用方在渲染时：组渲染在 groups.get(msg.id) 命中的位置，memberIds 中的其它消息跳过。
 */
export function buildFileToolGroups(messages: ChatMessageDTO[]): {
  groups: Map<string, FileToolGroup>;
  memberIds: Set<string>;
} {
  const byEntry = new Map<string, ChatMessageDTO[]>();
  for (const msg of messages) {
    if (!isFileToolCall(msg)) continue;
    const entryId = assistantEntryId(msg.id);
    const list = byEntry.get(entryId);
    if (list) list.push(msg);
    else byEntry.set(entryId, [msg]);
  }

  const groups = new Map<string, FileToolGroup>();
  const memberIds = new Set<string>();
  for (const calls of byEntry.values()) {
    const first = calls[0];
    groups.set(first.id, { id: first.id, calls });
    for (const call of calls) memberIds.add(call.id);
  }
  return { groups, memberIds };
}

/** 解析 tool_args_json：返回格式化文本与对象形式（无法解析时 argsStr 为原始文本，parsedArgs 为 null） */
export function parseToolArgsJson(raw: string | null | undefined): {
  argsStr: string;
  parsedArgs: Record<string, unknown> | null;
} {
  if (!raw) return { argsStr: '', parsedArgs: null };
  try {
    const parsed: unknown = JSON.parse(raw);
    const str = JSON.stringify(parsed, null, 2);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { argsStr: str, parsedArgs: parsed as Record<string, unknown> };
    }
    return { argsStr: str, parsedArgs: null };
  } catch {
    return { argsStr: raw, parsedArgs: null };
  }
}

/** read 内容展示上限：pi 单次最多读 2000 行，避免超长文件展开时渲染过多 DOM */
export const READ_MAX_LINES = 500;

/** pi 在结果末尾追加的续读/截断提示行（形如 `[Showing lines 1-501 of 900. ...]`），单独展示且不计入正文行数 */
const READ_NOTICE_PATTERN = /^\[(?:Showing lines|Line \d+ is |\d+ more lines in file)/;

/** 拆分 read 结果：正文与 pi 尾部提示（提示不参与行数统计与截断） */
export function splitReadContent(content: string): { body: string; notice: string | null } {
  const idx = content.lastIndexOf('\n\n[');
  if (idx === -1) return { body: content, notice: null };
  const candidate = content.slice(idx + 2);
  if (READ_NOTICE_PATTERN.test(candidate)) {
    return { body: content.slice(0, idx), notice: candidate.trim() };
  }
  return { body: content, notice: null };
}

/** result 文本以 Error 开头视为失败（pi-client 对 isError 结果加的前缀；全仓库统一口径） */
export function isToolErrorMessage(text: string | null | undefined): boolean {
  return /^error/i.test((text ?? '').trim());
}

/**
 * 收集「已由聚合卡片承载」的文件类结果消息 id。
 *
 * 对当前视图内每个文件类调用，用与 findToolResultMessage 相同的配对口径（toolCallId 精确优先、
 * 序数回退）反查其绑定结果；只有这些结果才应隐藏独立结果卡片。
 * 分页边界下调用不在视图内的孤立结果不会进入集合，调用方应降级渲染原结果卡片，避免失败反馈丢失。
 */
export function collectCoveredFileToolResultIds(visibleMessages: ChatMessageDTO[]): Set<string> {
  const covered = new Set<string>();
  for (const msg of visibleMessages) {
    if (!isFileToolCall(msg)) continue;
    const result = findToolResultMessage(
      visibleMessages,
      msg.id,
      msg.tool_name || 'unknown',
      msg.tool_call_id,
    );
    if (result) covered.add(result.id);
  }
  return covered;
}
