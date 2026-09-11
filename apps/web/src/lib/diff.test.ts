import { describe, expect, test } from 'bun:test';
import { computeLineDiff, computeWriteDiff, truncateDiff, type DiffLine } from './diff';

describe('computeWriteDiff', () => {
  test('多行内容逐行标记为新增', () => {
    expect(computeWriteDiff('a\nb')).toEqual<DiffLine[]>([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  test('末尾换行不额外产生空行（与头部 +N 统计一致）', () => {
    expect(computeWriteDiff('a\nb\n')).toHaveLength(2);
    expect(computeWriteDiff('a\nb\n')).toEqual<DiffLine[]>([
      { type: 'add', text: 'a' },
      { type: 'add', text: 'b' },
    ]);
  });

  test('空内容无 diff 行', () => {
    expect(computeWriteDiff('')).toEqual([]);
  });
});

describe('computeLineDiff', () => {
  test('修改行产生一条删除 + 一条新增', () => {
    const lines = computeLineDiff('a\nb', 'a\nc');
    expect(lines.filter((l) => l.type === 'add')).toHaveLength(1);
    expect(lines.filter((l) => l.type === 'delete')).toHaveLength(1);
    expect(lines.filter((l) => l.type === 'same')).toHaveLength(1);
  });

  test('相同内容全部为 same', () => {
    expect(computeLineDiff('a\nb', 'a\nb').every((l) => l.type === 'same')).toBe(true);
  });

  test('纯新增与纯删除', () => {
    expect(computeLineDiff('', 'a\nb').filter((l) => l.type === 'add')).toHaveLength(2);
    expect(computeLineDiff('a\nb', '').filter((l) => l.type === 'delete')).toHaveLength(2);
  });

  test('末尾换行不影响增删计数', () => {
    const withTrailingNewline = computeLineDiff('a\nb\n', 'a\nc\n');
    const withoutTrailingNewline = computeLineDiff('a\nb', 'a\nc');
    expect(withTrailingNewline.map((l) => l.type)).toEqual(withoutTrailingNewline.map((l) => l.type));
    expect(withTrailingNewline.filter((l) => l.type === 'same' && l.text === '')).toHaveLength(0);
  });

  test('空文本之间无 diff 行', () => {
    expect(computeLineDiff('', '')).toEqual([]);
  });
});

describe('truncateDiff', () => {
  const linesOf = (n: number): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ type: 'add' as const, text: `line ${i}` }));

  test('未超过上限时原样返回', () => {
    const lines = linesOf(5);
    const result = truncateDiff(lines, 10);
    expect(result.truncated).toBe(false);
    expect(result.lines).toHaveLength(5);
  });

  test('超过上限时截断并保留首尾与省略占位', () => {
    const result = truncateDiff(linesOf(300), 150);
    expect(result.truncated).toBe(true);
    expect(result.lines).toHaveLength(150);
    expect(result.lines.some((l) => l.type === 'same' && l.text.includes('more lines'))).toBe(true);
    expect(result.lines[0].text).toBe('line 0');
    expect(result.lines[result.lines.length - 1].text).toBe('line 299');
  });
});
