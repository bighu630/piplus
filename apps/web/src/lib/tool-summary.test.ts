import { describe, expect, test } from 'bun:test';
import type { ChatMessageDTO } from '@piplus/shared';
import {
  buildFileToolGroups,
  findToolResultMessage,
  formatReadLineRange,
  isFileToolCall,
  collectCoveredToolResultIds,
  collectMergedToolCallGroups,
  isToolErrorMessage,
  parseToolArgsJson,
  parseWriteEditDiff,
  splitLineCount,
  splitReadContent,
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
  test('优先按 toolCallId 精确匹配（同轮多次同名调用不错配）', () => {
    const messages = [
      msg({ id: 'call-1', tool_name: 'read', tool_args_json: '{}', tool_call_id: 'tc-1' }),
      msg({ id: 'call-2', tool_name: 'read', tool_args_json: '{}', tool_call_id: 'tc-2' }),
      msg({ id: 'result-1', role: 'tool', message_kind: 'tool', tool_name: 'read', tool_call_id: 'tc-1', content_text: 'file A' }),
      msg({ id: 'result-2', role: 'tool', message_kind: 'tool', tool_name: 'read', tool_call_id: 'tc-2', content_text: 'file B' }),
    ];

    expect(findToolResultMessage(messages, 'call-1', 'read', 'tc-1')?.content_text).toBe('file A');
    expect(findToolResultMessage(messages, 'call-2', 'read', 'tc-2')?.content_text).toBe('file B');
  });

  test('无 toolCallId 时回退序数配对：第 k 个同名调用 ↔ 第 k 个同名结果', () => {
    const messages = [
      msg({ id: 'call-1', tool_name: 'read' }),
      msg({ id: 'call-2', tool_name: 'read' }),
      msg({ id: 'result-1', role: 'tool', message_kind: 'tool', tool_name: 'read', content_text: 'file A' }),
      msg({ id: 'result-2', role: 'tool', message_kind: 'tool', tool_name: 'read', content_text: 'file B' }),
    ];

    expect(findToolResultMessage(messages, 'call-1', 'read')?.content_text).toBe('file A');
    expect(findToolResultMessage(messages, 'call-2', 'read')?.content_text).toBe('file B');
  });

  test('序数回退：交错顺序（c1,r1,c2,r2,c3,r3）也正确', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'read' }),
      msg({ id: 'r1', role: 'tool', message_kind: 'tool', tool_name: 'read', content_text: 'A' }),
      msg({ id: 'c2', tool_name: 'read' }),
      msg({ id: 'r2', role: 'tool', message_kind: 'tool', tool_name: 'read', content_text: 'B' }),
      msg({ id: 'c3', tool_name: 'read' }),
      msg({ id: 'r3', role: 'tool', message_kind: 'tool', tool_name: 'read', content_text: 'C' }),
    ];

    expect(findToolResultMessage(messages, 'c1', 'read')?.content_text).toBe('A');
    expect(findToolResultMessage(messages, 'c2', 'read')?.content_text).toBe('B');
    expect(findToolResultMessage(messages, 'c3', 'read')?.content_text).toBe('C');
  });

  test('调用侧带 id 但结果侧缺 id 时回退序数配对', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'read', tool_call_id: 'tc-1' }),
      msg({ id: 'r1', role: 'tool', message_kind: 'tool', tool_name: 'read', content_text: 'A' }),
    ];

    expect(findToolResultMessage(messages, 'c1', 'read', 'tc-1')?.content_text).toBe('A');
  });

  test('序数回退：结果数量不足时返回 null（调用方降级 args）', () => {
    const messages = [
      msg({ id: 'call-1', tool_name: 'read' }),
      msg({ id: 'call-2', tool_name: 'read' }),
      msg({ id: 'result-1', role: 'tool', message_kind: 'tool', tool_name: 'read' }),
    ];

    expect(findToolResultMessage(messages, 'call-2', 'read')).toBeNull();
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

describe('isFileToolCall', () => {
  test('仅 write/edit/read 的 tool_call 为文件类', () => {
    expect(isFileToolCall(msg({ id: 'c1', tool_name: 'write' }))).toBe(true);
    expect(isFileToolCall(msg({ id: 'c2', tool_name: 'edit' }))).toBe(true);
    expect(isFileToolCall(msg({ id: 'c3', tool_name: 'read' }))).toBe(true);
    expect(isFileToolCall(msg({ id: 'c4', tool_name: 'bash' }))).toBe(false);
    // 工具结果消息不算调用
    expect(isFileToolCall(msg({ id: 'c5', role: 'tool', message_kind: 'tool', tool_name: 'read' }))).toBe(false);
  });
});

describe('buildFileToolGroups', () => {
  test('同一条 assistant 消息的多个文件调用聚合成一组', () => {
    const messages = [
      msg({ id: 'e1-tool-0', tool_name: 'write' }),
      msg({ id: 'e1-tool-1', tool_name: 'read' }),
      msg({ id: 'e1-tool-2', tool_name: 'edit' }),
    ];
    const { groups, memberIds } = buildFileToolGroups(messages);

    expect(groups.size).toBe(1);
    expect(groups.get('e1-tool-0')!.calls.map((c) => c.id)).toEqual(['e1-tool-0', 'e1-tool-1', 'e1-tool-2']);
    expect([...memberIds].sort()).toEqual(['e1-tool-0', 'e1-tool-1', 'e1-tool-2']);
  });

  test('不同 assistant 消息分开成组，各自渲染锚点为组内首条', () => {
    const messages = [
      msg({ id: 'e1-tool-0', tool_name: 'write' }),
      msg({ id: 'e2-tool-0', tool_name: 'write' }),
      msg({ id: 'e2-tool-1', tool_name: 'edit' }),
    ];
    const { groups } = buildFileToolGroups(messages);

    expect(groups.size).toBe(2);
    expect(groups.get('e1-tool-0')!.calls).toHaveLength(1);
    expect(groups.get('e2-tool-0')!.calls).toHaveLength(2);
    expect(groups.has('e2-tool-1')).toBe(false);
  });

  test('非文件类调用与工具结果不参与分组', () => {
    const messages = [
      msg({ id: 'e1-tool-0', tool_name: 'write' }),
      msg({ id: 'e2-tool-0', tool_name: 'bash' }),
      msg({ id: 'r1', role: 'tool', message_kind: 'tool', tool_name: 'write' }),
      msg({ id: 'e1-tool-1', tool_name: 'read' }),
    ];
    const { groups, memberIds } = buildFileToolGroups(messages);

    expect(groups.size).toBe(1);
    expect(groups.get('e1-tool-0')!.calls.map((c) => c.id)).toEqual(['e1-tool-0', 'e1-tool-1']);
    expect(memberIds.has('e2-tool-0')).toBe(false);
    expect(memberIds.has('r1')).toBe(false);
  });

  test('无文件类调用时返回空结果', () => {
    const { groups, memberIds } = buildFileToolGroups([msg({ id: 'c1', tool_name: 'bash' })]);
    expect(groups.size).toBe(0);
    expect(memberIds.size).toBe(0);
  });
});

describe('parseToolArgsJson', () => {
  test('对象 args 返回格式化文本与对象', () => {
    const { argsStr, parsedArgs } = parseToolArgsJson('{"a":1}');
    expect(parsedArgs).toEqual({ a: 1 });
    expect(argsStr).toContain('"a": 1');
  });

  test('非法 JSON 返回原始文本且 parsedArgs 为 null', () => {
    const { argsStr, parsedArgs } = parseToolArgsJson('{oops');
    expect(argsStr).toBe('{oops');
    expect(parsedArgs).toBeNull();
  });

  test('数组 / 空值不视为对象 args', () => {
    expect(parseToolArgsJson('[1,2]').parsedArgs).toBeNull();
    expect(parseToolArgsJson(null).argsStr).toBe('');
    expect(parseToolArgsJson('').parsedArgs).toBeNull();
  });
});

describe('splitReadContent', () => {
  test('剥离 pi 续读提示行', () => {
    const { body, notice } = splitReadContent('l1\nl2\n\n[Showing lines 1-2 of 900. Use offset=3 to continue.]');
    expect(body).toBe('l1\nl2');
    expect(notice).toBe('[Showing lines 1-2 of 900. Use offset=3 to continue.]');
  });

  test('剥离 more lines / 超限提示', () => {
    expect(splitReadContent('l1\n\n[10 more lines in file. Use offset=2 to continue.]').notice).toContain('more lines in file');
    expect(splitReadContent('l1\n\n[Line 5 is 60.0KB, exceeds 50.0KB limit. Use bash: sed]').notice).toContain('exceeds');
  });

  test('普通内容（含非提示方括号）不拆分', () => {
    const content = 'const a = [1, 2];\nconst b = [3];';
    expect(splitReadContent(content)).toEqual({ body: content, notice: null });
  });
});

describe('isToolErrorMessage', () => {
  test('Error 前缀（大小写/前导空白）视为失败', () => {
    expect(isToolErrorMessage('Error: x')).toBe(true);
    expect(isToolErrorMessage('  error: x')).toBe(true);
    expect(isToolErrorMessage('ERROR: x')).toBe(true);
    expect(isToolErrorMessage('ok')).toBe(false);
    expect(isToolErrorMessage('')).toBe(false);
    expect(isToolErrorMessage(null)).toBe(false);
  });
});

describe('collectCoveredToolResultIds', () => {
  test('文件类与普通工具的绑定结果都收集（toolCallId 精确配对）', () => {
    const messages = [
      msg({ id: 't1-tool-8', tool_name: 'write', tool_call_id: 't1-8' }),
      msg({ id: 'r8', role: 'tool', message_kind: 'tool', tool_name: 'write', tool_call_id: 't1-8' }),
      msg({ id: 'c-bash', tool_name: 'bash', tool_call_id: 'tc-b' }),
      msg({ id: 'r-bash', role: 'tool', message_kind: 'tool', tool_name: 'bash', tool_call_id: 'tc-b' }),
      // 孤立结果：对应调用已被分页切走，虽同名但不应被收集
      msg({ id: 'r9', role: 'tool', message_kind: 'tool', tool_name: 'write', tool_call_id: 't1-9' }),
    ];
    const covered = collectCoveredToolResultIds(messages);
    expect(covered.has('r8')).toBe(true);
    expect(covered.has('r-bash')).toBe(true);
    expect(covered.has('r9')).toBe(false);
  });

  test('例外工具（ask_question / spawn_session / send_message_to_session）的结果不收集', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'ask_question', tool_call_id: 'ta' }),
      msg({ id: 'ra', role: 'tool', message_kind: 'tool', tool_name: 'ask_question', tool_call_id: 'ta' }),
      msg({ id: 'c2', tool_name: 'spawn_session', tool_call_id: 'ts' }),
      msg({ id: 'rs', role: 'tool', message_kind: 'tool', tool_name: 'spawn_session', tool_call_id: 'ts' }),
      msg({ id: 'c3', tool_name: 'send_message_to_session', tool_call_id: 'tm' }),
      msg({ id: 'rm', role: 'tool', message_kind: 'tool', tool_name: 'send_message_to_session', tool_call_id: 'tm' }),
    ];
    expect(collectCoveredToolResultIds(messages).size).toBe(0);
  });

  test('序数回退配对（无 toolCallId 的旧数据）也能收集', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'read' }),
      msg({ id: 'r1', role: 'tool', message_kind: 'tool', tool_name: 'read' }),
    ];
    expect(collectCoveredToolResultIds(messages).has('r1')).toBe(true);
  });

  test('调用无对应结果时不收集', () => {
    expect(collectCoveredToolResultIds([msg({ id: 'c1', tool_name: 'write', tool_call_id: 't1-1' })]).size).toBe(0);
  });
});

describe('collectMergedToolCallGroups', () => {
  const okResult = (id: string, toolName: string, callId: string) =>
    msg({ id, role: 'tool', message_kind: 'tool', tool_name: toolName, tool_call_id: callId, content_text: 'ok' });

  test('连续相邻的同一工具成功调用合并为一组', () => {
    const messages = [
      msg({ id: 'e1-tool-0', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      msg({ id: 'e1-tool-1', tool_name: 'bash', tool_call_id: 't2' }),
      okResult('r2', 'bash', 't2'),
      msg({ id: 'e1-tool-2', tool_name: 'bash', tool_call_id: 't3' }),
      okResult('r3', 'bash', 't3'),
    ];
    const { groups, memberIds } = collectMergedToolCallGroups(messages);

    expect(groups.size).toBe(1);
    const group = groups.get('e1-tool-0')!;
    expect(group.toolName).toBe('bash');
    expect(group.calls.map((c) => c.id)).toEqual(['e1-tool-0', 'e1-tool-1', 'e1-tool-2']);
    expect([...memberIds].sort()).toEqual(['e1-tool-0', 'e1-tool-1', 'e1-tool-2']);
  });

  test('跨 assistant 消息的连续同工具调用也合并', () => {
    const messages = [
      msg({ id: 'e1-tool-0', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      msg({ id: 'e2-tool-0', tool_name: 'bash', tool_call_id: 't2' }),
      okResult('r2', 'bash', 't2'),
    ];
    const { groups, memberIds } = collectMergedToolCallGroups(messages);

    expect(groups.get('e1-tool-0')!.calls).toHaveLength(2);
    expect(memberIds.has('e2-tool-0')).toBe(true);
  });

  test('中间出现其它工具或普通消息则断开', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      msg({ id: 'c2', tool_name: 'grep', tool_call_id: 't2' }),
      okResult('r2', 'grep', 't2'),
      msg({ id: 'u1', role: 'user', message_kind: 'normal', content_text: 'hi' }),
      msg({ id: 'c3', tool_name: 'bash', tool_call_id: 't3' }),
      okResult('r3', 'bash', 't3'),
    ];
    expect(collectMergedToolCallGroups(messages).groups.size).toBe(0);
  });

  test('失败的调用不参与合并（并作为断点）', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      msg({ id: 'c2', tool_name: 'bash', tool_call_id: 't2' }),
      msg({ id: 'r2', role: 'tool', message_kind: 'tool', tool_name: 'bash', tool_call_id: 't2', content_text: 'Error: fail' }),
      msg({ id: 'c3', tool_name: 'bash', tool_call_id: 't3' }),
      okResult('r3', 'bash', 't3'),
    ];
    expect(collectMergedToolCallGroups(messages).groups.size).toBe(0);
  });

  test('结果未回（运行中）不参与合并', () => {
    const messages = [
      msg({ id: 'c1', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      msg({ id: 'c2', tool_name: 'bash', tool_call_id: 't2' }),
    ];
    expect(collectMergedToolCallGroups(messages).groups.size).toBe(0);
  });

  test('断点之后仍能继续成组（前段/后段各成一组）', () => {
    const messages = [
      msg({ id: 'b1', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      msg({ id: 'b2', tool_name: 'bash', tool_call_id: 't2' }),
      okResult('r2', 'bash', 't2'),
      msg({ id: 'g1', tool_name: 'grep', tool_call_id: 't3' }),
      okResult('r3', 'grep', 't3'),
      msg({ id: 'b3', tool_name: 'bash', tool_call_id: 't4' }),
      okResult('r4', 'bash', 't4'),
      msg({ id: 'b4', tool_name: 'bash', tool_call_id: 't5' }),
      okResult('r5', 'bash', 't5'),
    ];
    const { groups, memberIds } = collectMergedToolCallGroups(messages);

    expect(groups.size).toBe(2);
    expect([...groups.values()].map((g) => g.calls.map((c) => c.id))).toEqual([
      ['b1', 'b2'],
      ['b3', 'b4'],
    ]);
    expect(memberIds.has('b3')).toBe(true);
    expect(memberIds.has('g1')).toBe(false);
  });

  test('其它工具的孤立结果同样作为断点', () => {
    const messages = [
      msg({ id: 'b1', tool_name: 'bash', tool_call_id: 't1' }),
      okResult('r1', 'bash', 't1'),
      okResult('orphan', 'grep', 'tg'),
      msg({ id: 'b2', tool_name: 'bash', tool_call_id: 't2' }),
      okResult('r2', 'bash', 't2'),
    ];
    expect(collectMergedToolCallGroups(messages).groups.size).toBe(0);
  });

  test('文件类与例外工具不参与合并', () => {
    const messages = [
      msg({ id: 'w1', tool_name: 'write', tool_call_id: 't1' }),
      okResult('r1', 'write', 't1'),
      msg({ id: 'w2', tool_name: 'write', tool_call_id: 't2' }),
      okResult('r2', 'write', 't2'),
      msg({ id: 's1', tool_name: 'spawn_session', tool_call_id: 't3' }),
      okResult('r3', 'spawn_session', 't3'),
      msg({ id: 's2', tool_name: 'spawn_session', tool_call_id: 't4' }),
      okResult('r4', 'spawn_session', 't4'),
    ];
    expect(collectMergedToolCallGroups(messages).groups.size).toBe(0);
  });
});
