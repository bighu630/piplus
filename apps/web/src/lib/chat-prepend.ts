/**
 * 根据前后两次渲染的消息 id 列表，推导「本次前置插入（prepend）的消息 id」。
 *
 * 判定规则：
 * - 只有上一次的首条仍存在于当前列表、且其位置 `> 0` 时才算 prepend：
 *   它前面的 id 就是新增的、更早的历史消息（保持顺序）。
 * - 会话切换、列表被整体替换、首条变化但旧首条已消失（`oldFirstIdx === -1`）、
 *   或仅由 `empty_placeholder` / `stream-pending-*` 这类合成占位消息引起的变化，
 *   都返回 `[]`，避免误把「非前置插入」当成分页 prepend 去做滚动补偿。
 */
export function derivePrependedIds(
  prevIds: readonly string[],
  currentIds: readonly string[],
): string[] {
  if (prevIds.length === 0 || currentIds.length === 0) return [];
  const previousFirst = prevIds[0];
  if (previousFirst === undefined) return [];
  const oldFirstIdx = currentIds.indexOf(previousFirst);
  if (oldFirstIdx <= 0) return [];
  return currentIds.slice(0, oldFirstIdx);
}
