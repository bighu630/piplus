import { describe, expect, test } from 'bun:test';
import type { ChatMessageDTO } from '@piplus/shared';
import {
  findToolResultMessage,
  formatReadLineRange,
  parseWriteEditDiff,
  splitLineCount,
  summarizeWriteEdit,
} from './tool-summary';

function msg(partial: Partial<ChatMessageDTO> & { id: string }): ChatMessageDTO {
  return {
    role: 'assistant',
    message_kind: 'tool_call',
    source_session_id: null,
    content_text: '',
    created_at: new Date().toISOString(),
    ...partial,
  };
}

describe('splitLineCount', () => {
  test('空文本为 0 行', () => {
    expect(splitLineCount('')).toBe(0);
  });

  test('末尾换行不额外计一行', () => {
    expect(splitLineCount('a\nb\n')).toBe(2);
  });

  test('普通多行与单行', () => {
    expect(splitLineCount('a\nb\nc')).toBe(3);
    expect(splitLineCount('only')).toBe(1);
  });
});

describe('parseWriteEditDiff', () => {
  test('write：path + content 作为新文本', () => {
    expect(parseWriteEditDiff('write', { path: 'src/a.ts', content: 'x' })).toEqual({
      path: 'src/a.ts',
      newText: 'x',
    });
  });

  test('edit：合并多条 edits 的 oldText/newText', () => {
    const parsed = parseWriteEditDiff('edit', {
      path: 'a.ts',
      edits: [
        { oldText: 'a', newText: 'b' },
        { oldText: 'c', newText: 'd' },
      ],
    });
    expect(parsed).toEqual({ path: 'a.ts', oldText: 'a\nc', newText: 'b\nd' });
  });

  test('edit：兼容 oldText/newText 直传', () => {
    expect(parseWriteEditDiff('edit', { path: 'a.ts', oldText: 'old', newText: 'new' })).toEqual({
      path: 'a.ts',
      oldText: 'old',
      newText: 'new',
    });
  });

  test('非 write/edit 返回 null', () => {
    expect(parseWriteEditDiff('bash', { command: 'ls' })).toBeNull();
    expect(parseWriteEditDiff('read', { path: 'a.ts' })).toBeNull();
  });
});

describe('summarizeWriteEdit - write', () => {
  test('显示文件与新增行数，removed 恒为 0', () => {
    expect(summarizeWriteEdit('write', { path: 'src/a.ts', content: 'l1\nl2\nl3' })).toEqual({
      path: 'src/a.ts',
      added: 3,
      removed: 0,
    });
  });

  test('空内容为 +0', () => {
    expect(summarizeWriteEdit('write', { path: 'a.ts', content: '' })).toEqual({
      path: 'a.ts',
      added: 0,
      removed: 0,
    });
  });

  test('缺少 path 时为 null，行数照常统计', () => {
    expect(summarizeWriteEdit('write', { content: 'a\nb' })).toEqual({
      path: null,
      added: 2,
      removed: 0,
    });
  });

  test('非 write/edit 返回 null', () => {
    expect(summarizeWriteEdit('bash', { command: 'ls' })).toBeNull();
  });
});

describe('summarizeWriteEdit - edit', () => {
  test('优先使用结果 details.diff 的精确统计', () => {
    const details = {
      diff: '+1  const a = 1;\n+2  const b = 2;\n-1  const a = 0;\n 3  unchanged',
      patch: '...',
      firstChangedLine: 1,
    };
    expect(
      summarizeWriteEdit('edit', { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] }, details),
    ).toEqual({ path: 'a.ts', added: 2, removed: 1 });
  });

  test('details 缺失时回退 args 行级 diff', () => {
    expect(
      summarizeWriteEdit('edit', { path: 'a.ts', edits: [{ oldText: 'a\nb', newText: 'a\nc' }] }),
    ).toEqual({ path: 'a.ts', added: 1, removed: 1 });
  });

  test('多条 edits 分别统计后累加', () => {
    expect(
      summarizeWriteEdit('edit', {
        path: 'a.ts',
        edits: [
          { oldText: 'a', newText: 'a\nnew1' },
          { oldText: 'b\nc', newText: 'b' },
        ],
      }),
    ).toEqual({ path: 'a.ts', added: 1, removed: 1 });
  });

  test('details 无 diff 时回退 args（如其它工具的 details）', () => {
    expect(
      summarizeWriteEdit('edit', { path: 'a.ts', oldText: 'x', newText: 'y' }, { truncation: {} }),
    ).toEqual({ path: 'a.ts', added: 1, removed: 1 });
  });

  test('args 无法识别返回 null', () => {
    expect(summarizeWriteEdit('edit', { path: 'a.ts' })).toBeNull();
  });
});

describe('formatReadLineRange', () => {
  test('offset + limit → 起始-结束（1-indexed，含端点，limit 为行数）', () => {
    expect(formatReadLineRange({ path: 'a.ts', offset: 100, limit: 50 })).toBe('100-149');
    expect(formatReadLineRange({ path: 'a.ts', offset: 1, limit: 1 })).toBe('1-1');
  });

  test('仅 offset → 100+', () => {
    expect(formatReadLineRange({ path: 'a.ts', offset: 100 })).toBe('100+');
  });

  test('仅 limit → 1-50', () => {
    expect(formatReadLineRange({ path: 'a.ts', limit: 50 })).toBe('1-50');
  });

  test('都没有 → 不显示行号', () => {
    expect(formatReadLineRange({ path: 'a.ts' })).toBeNull();
  });

  test('非法值视为缺失', () => {
    expect(formatReadLineRange({ offset: 0, limit: -3 })).toBeNull();
    expect(formatReadLineRange({ offset: 10, limit: 0 })).toBe('10+');
    expect(formatReadLineRange({ offset: '100', limit: 50 })).toBe('1-50');
  });
});

describe('findToolResultMessage', () => {
  test('返回 tool_call 之后第一条同名工具结果', () => {
    const messages = [
      msg({ id: 'call-1', tool_name: 'edit', tool_args_json: '{}' }),
      msg({ id: 'result-1', role: 'tool', message_kind: 'tool', tool_name: 'edit', details: { diff: '+1 a' } }),
      msg({ id: 'result-2', role: 'tool', message_kind: 'tool', tool_name: 'edit' }),
    ];
    expect(findToolResultMessage(messages, 'call-1', 'edit')?.id).toBe('result-1');
  });

  test('无对应结果返回 null', () => {
    const messages = [msg({ id: 'call-1', tool_name: 'edit' })];
    expect(findToolResultMessage(messages, 'call-1', 'edit')).toBeNull();
  });

  test('不匹配同名工具之外的结果', () => {
    const messages = [
      msg({ id: 'call-1', tool_name: 'edit' }),
      msg({ id: 'result-1', role: 'tool', message_kind: 'tool', tool_name: 'read' }),
    ];
    expect(findToolResultMessage(messages, 'call-1', 'edit')).toBeNull();
  });
});
