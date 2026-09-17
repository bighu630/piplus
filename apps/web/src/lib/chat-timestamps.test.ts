import { describe, expect, test } from 'bun:test';
import { computeVisibleTimestampIds, pickTimestampText } from './chat-timestamps';

const at = (id: string, time: string) => ({ id, created_at: time });

describe('computeVisibleTimestampIds', () => {
  const messages = [at('m1', '2026-01-01T10:00:00Z'), at('m2', '2026-01-01T10:01:00Z'), at('m3', '2026-01-01T10:02:00Z')];

  test('设置关闭：返回 null（全部可见，行为不变）', () => {
    expect(computeVisibleTimestampIds(messages, { enabled: false, hasMore: false })).toBeNull();
    expect(computeVisibleTimestampIds(messages, { enabled: false, hasMore: true })).toBeNull();
  });

  test('开启且历史已全部加载：仅首尾两条可见', () => {
    const ids = computeVisibleTimestampIds(messages, { enabled: true, hasMore: false });
    expect(ids).toEqual(new Set(['m1', 'm3']));
  });

  test('开启且还有更早历史：列表首条不是会话首条，仅末条可见', () => {
    const ids = computeVisibleTimestampIds(messages, { enabled: true, hasMore: true });
    expect(ids).toEqual(new Set(['m3']));
  });

  test('单条消息：首尾同一条，只出现一次', () => {
    const ids = computeVisibleTimestampIds([at('only', '2026-01-01T10:00:00Z')], { enabled: true, hasMore: false });
    expect(ids).toEqual(new Set(['only']));
  });

  test('空列表：返回空集合（不抛错）', () => {
    const ids = computeVisibleTimestampIds([], { enabled: true, hasMore: false });
    expect(ids).toEqual(new Set());
  });
});

describe('pickTimestampText', () => {
  test('设置关闭（null）：返回 undefined，调用方沿用默认时间', () => {
    expect(pickTimestampText(null, [at('m1', '2026-01-01T10:00:00Z')])).toBeUndefined();
  });

  test('单条命中：返回该消息 created_at', () => {
    const visible = new Set(['m1']);
    expect(pickTimestampText(visible, [at('m1', '2026-01-01T10:00:00Z')])).toBe('2026-01-01T10:00:00Z');
  });

  test('未命中：返回 null（隐藏）', () => {
    const visible = new Set(['m9']);
    expect(pickTimestampText(visible, [at('m1', '2026-01-01T10:00:00Z')])).toBeNull();
  });

  test('组内命中多个时取最靠后的成员（末条消息所在组显示末条成员时间）', () => {
    const visible = new Set(['m1', 'm3']);
    const group = [at('m1', '10:00'), at('m2', '10:01'), at('m3', '10:02')];
    expect(pickTimestampText(visible, group)).toBe('10:02');
  });

  test('组内仅首条命中时返回首条时间', () => {
    const visible = new Set(['m1']);
    const group = [at('m1', '10:00'), at('m2', '10:01'), at('m3', '10:02')];
    expect(pickTimestampText(visible, group)).toBe('10:00');
  });
});
