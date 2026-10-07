import { describe, expect, test } from 'bun:test';
import { derivePrependedIds } from './chat-prepend';

describe('derivePrependedIds', () => {
  test('真 prepend：返回旧首条之前的全部新增 id（保序）', () => {
    expect(derivePrependedIds(['m6', 'm7'], ['m3', 'm4', 'm5', 'm6', 'm7'])).toEqual(['m3', 'm4', 'm5']);
  });

  test('只新增一条前置消息', () => {
    expect(derivePrependedIds(['m2', 'm3'], ['m1', 'm2', 'm3'])).toEqual(['m1']);
  });

  test('尾部 append 不视为 prepend', () => {
    expect(derivePrependedIds(['m1', 'm2'], ['m1', 'm2', 'm3'])).toEqual([]);
  });

  test('无变化返回空', () => {
    expect(derivePrependedIds(['m1', 'm2'], ['m1', 'm2'])).toEqual([]);
  });

  test('会话切换 / 列表整体替换（旧首条消失）返回空', () => {
    expect(derivePrependedIds(['m1', 'm2'], ['n1', 'n2'])).toEqual([]);
  });

  test('旧首条仍在但只要位置前移就算 prepend；位置不变则不算', () => {
    // 旧首条 m2 仍在，但当前首位是 m1：正是 prepend 场景 → [m1]
    expect(derivePrependedIds(['m2'], ['m1', 'm2'])).toEqual(['m1']);
    // 旧首条 m1 仍为首位 → 非 prepend
    expect(derivePrependedIds(['m1', 'm2'], ['m1', 'm2'])).toEqual([]);
  });

  test('初次加载（prev 为空）不算 prepend', () => {
    expect(derivePrependedIds([], ['m1', 'm2'])).toEqual([]);
  });

  test('合成占位消息引起首条变化：旧首条不在当前列表 → 返回空', () => {
    expect(derivePrependedIds(['stream-pending-1'], ['m1', 'stream-pending-2'])).toEqual([]);
    expect(derivePrependedIds(['empty_placeholder'], ['m1'])).toEqual([]);
  });
});
