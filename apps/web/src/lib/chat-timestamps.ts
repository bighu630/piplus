import type { ChatMessageDTO } from '@piplus/shared';

/**
 * 「隐藏对话框时间戳」设置（settings key: `hide_chat_timestamps`）的显示口径：
 * 开启后仅保留会话第一条与最后一条消息的时间戳。
 */

export interface TimestampVisibilityOptions {
  /** 设置项是否开启（未设置 / 'false' 时为 false，保持既有行为） */
  enabled: boolean;
  /** 是否还有更早历史未加载（true 时列表首条不是会话首条，顶部不显示时间戳） */
  hasMore: boolean;
}

/**
 * 计算开启设置后仍可见时间戳的消息 id 集合。
 *
 * - 关闭时返回 `null`，表示全部可见（调用方无需逐条判断）
 * - 开启时返回仅含「会话第一条（仅当历史已全部加载）」与「会话最后一条」的集合
 */
export function computeVisibleTimestampIds(
  messages: readonly { id: string }[],
  { enabled, hasMore }: TimestampVisibilityOptions,
): Set<string> | null {
  if (!enabled) return null;
  if (messages.length === 0) return new Set();

  const ids = new Set<string>();
  const last = messages[messages.length - 1];
  if (last) ids.add(last.id);
  const first = messages[0];
  if (!hasMore && first) ids.add(first.id);
  return ids;
}

/**
 * 为单条消息或一个卡片组挑选要显示的时间戳文本。
 *
 * - `visibleIds === null`（设置关闭）→ 返回 `undefined`，调用方沿用默认渲染
 * - 命中的成员 → 返回其 `created_at`；组内命中多个时取最靠后的成员，
 *   保证「最后一条消息」所在的合并/聚合卡片显示的是末条成员的时间
 * - 无命中 → 返回 `null`（隐藏）
 */
export function pickTimestampText(
  visibleIds: ReadonlySet<string> | null,
  messages: readonly Pick<ChatMessageDTO, 'id' | 'created_at'>[],
): string | null | undefined {
  if (visibleIds === null) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && visibleIds.has(msg.id)) return msg.created_at;
  }
  return null;
}
