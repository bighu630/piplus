import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import FileToolGroupCard from './FileToolGroupCard';

// 文件工具聚合卡片验收测试：
// - 同回合多个 write/edit/read 以多行文件列表展示
// - 每行点击=独立展开该文件明细
// - 卡片级只有一个「展开全部/收起全部」总控（按钮与头部）
// setup 模式参照 AskQuestionCard.test.tsx（happy-dom + React 19）。

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

function setupGlobals() {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
}

beforeAll(() => {
  setupGlobals();
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
});

function render(node: React.ReactElement) {
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
});

function click(el: Element | null) {
  act(() => {
    (el as HTMLButtonElement).click();
  });
}

function fileCall(id: string, toolName: string, args: Record<string, unknown>): ChatMessageDTO {
  return {
    id,
    role: 'assistant',
    message_kind: 'tool_call',
    source_session_id: null,
    content_text: '',
    created_at: new Date().toISOString(),
    tool_name: toolName,
    tool_args_json: JSON.stringify(args),
    // 模拟 pi 历史：call 与 result 都携带同一调用 id（前端据此精确配对）
    tool_call_id: id,
  };
}

function toolResult(id: string, toolName: string, toolCallId: string, content: string, details?: unknown): ChatMessageDTO {
  return {
    id,
    role: 'tool',
    message_kind: 'tool',
    source_session_id: null,
    content_text: content,
    created_at: new Date().toISOString(),
    tool_name: toolName,
    tool_call_id: toolCallId,
    details,
  };
}

function Harness({
  calls,
  messages = [],
  runningIds,
}: {
  calls: ChatMessageDTO[];
  messages?: ChatMessageDTO[];
  runningIds?: Set<string>;
}) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  return (
    <FileToolGroupCard
      calls={calls}
      messages={messages}
      expandedIds={expandedIds}
      onToggleOne={(id) => {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      }}
      onToggleAll={(ids, expand) => {
        setExpandedIds((prev) => {
          const next = new Set(prev);
          for (const id of ids) {
            if (expand) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      }}
      runningIds={runningIds ?? new Set()}
    />
  );
}

const rows = () => [...container!.querySelectorAll('[data-testid="tool-file-row"]')];
const details = () => [...container!.querySelectorAll('[data-testid="tool-file-detail"]')];
const allButton = () =>
  [...(container!.querySelectorAll('button') as unknown as HTMLButtonElement[])].find((b) =>
    b.textContent?.trim() === '展开全部' || b.textContent?.trim() === '收起全部',
  ) ?? null;
const header = () => container!.querySelector('[data-testid="tool-group-header"]');

const threeWrites = () => [
  fileCall('e1-tool-0', 'write', { path: 'src/a.ts', content: 'a1\na2' }),
  fileCall('e1-tool-1', 'write', { path: 'src/b.ts', content: 'b1' }),
  fileCall('e1-tool-2', 'write', { path: 'src/c.ts', content: '' }),
];

describe('FileToolGroupCard 文件列表', () => {
  test('多行文件列表 + 卡片级只有一个总控按钮', () => {
    render(<Harness calls={threeWrites()} />);

    expect(rows()).toHaveLength(3);
    expect(rows()[0].textContent).toContain('src/a.ts');
    expect(rows()[0].textContent).toContain('+2');
    expect(rows()[1].textContent).toContain('src/b.ts');
    expect(rows()[2].textContent).toContain('+0');
    expect(container!.querySelectorAll('button')).toHaveLength(1);
    expect(allButton()!.textContent!.trim()).toBe('展开全部');
    expect(header()!.textContent).toContain('write × 3');
  });

  test('默认收起：不渲染任何文件明细', () => {
    render(<Harness calls={threeWrites()} />);
    expect(details()).toHaveLength(0);
  });

  test('点击单个文件行只展开该文件明细，其它行仍收起', () => {
    render(<Harness calls={threeWrites()} />);

    click(rows()[1]);

    expect(details()).toHaveLength(1);
    expect(details()[0].textContent).toContain('b1');
    expect(details()[0].textContent).not.toContain('a1');
    // 非全展开状态：总控按钮仍是「展开全部」
    expect(allButton()!.textContent!.trim()).toBe('展开全部');
    // 行内 chevron 与明细展开状态一致
    expect(rows()[1].getAttribute('data-testid')).toBe('tool-file-row');
  });

  test('点击总控按钮展开全部文件，再点收起全部', () => {
    render(<Harness calls={threeWrites()} />);

    click(allButton());
    expect(details()).toHaveLength(3);
    expect(allButton()!.textContent!.trim()).toBe('收起全部');
    expect(header()!.textContent).toContain('收起全部');

    click(allButton());
    expect(details()).toHaveLength(0);
    expect(allButton()!.textContent!.trim()).toBe('展开全部');
  });

  test('点击头部同样触发全部展开/收起', () => {
    render(<Harness calls={threeWrites()} />);

    click(header());
    expect(details()).toHaveLength(3);

    click(header());
    expect(details()).toHaveLength(0);
  });

  test('单文件组也走同一结构（一行 + 一个总控）', () => {
    render(<Harness calls={[fileCall('e1-tool-0', 'edit', { path: 'src/only.ts', edits: [{ oldText: 'x', newText: 'y' }] })]} />);

    expect(rows()).toHaveLength(1);
    expect(container!.querySelectorAll('button')).toHaveLength(1);
    expect(header()!.textContent).toContain('edit');
    expect(header()!.textContent).not.toContain('×');
  });

  test('混合工具组：标签合并显示工具名与数量', () => {
    render(
      <Harness
        calls={[
          fileCall('e1-tool-0', 'write', { path: 'a.ts', content: 'x' }),
          fileCall('e1-tool-1', 'edit', { path: 'b.ts', edits: [{ oldText: 'x', newText: 'y' }] }),
          fileCall('e1-tool-2', 'read', { path: 'c.ts' }),
        ]}
      />,
    );
    expect(header()!.textContent).toContain('write + edit + read × 3');
  });

  test('文件名完整路径通过 title 提供（可见文本截断）', () => {
    const longPath = 'apps/web/src/components/very/deep/path/TabChat.tsx';
    render(<Harness calls={[fileCall('e1-tool-0', 'write', { path: longPath, content: 'x' })]} />);
    const pathEl = rows()[0].querySelector('[title]');
    expect(pathEl!.getAttribute('title')).toBe(longPath);
  });

  test('running 调用渲染 spinner', () => {
    render(<Harness calls={threeWrites()} runningIds={new Set(['e1-tool-1'])} />);
    expect(container!.querySelector('.animate-spin')).not.toBeNull();
  });
});

describe('FileToolGroupCard read 行', () => {
  const readCalls = [
    fileCall('e1-tool-0', 'read', { path: 'src/a.ts', offset: 100, limit: 50 }),
    fileCall('e1-tool-1', 'read', { path: 'src/b.ts' }),
  ];
  const messages = [
    toolResult('r1', 'read', 'e1-tool-0', 'content of a'),
    toolResult('r2', 'read', 'e1-tool-1', 'content of b'),
  ];

  test('行内显示行号范围（无参数则不显示）', () => {
    render(<Harness calls={readCalls} messages={messages} />);

    const ranges = [...container!.querySelectorAll('[data-testid="tool-call-line-range"]')];
    expect(ranges).toHaveLength(1);
    expect(ranges[0].textContent).toBe('100-149');
  });

  test('展开某行显示该文件读取内容（不带行号）', () => {
    render(<Harness calls={readCalls} messages={messages} />);

    click(rows()[1]);

    expect(details()).toHaveLength(1);
    expect(details()[0].querySelector('pre')!.textContent).toBe('content of b');
  });

  test('展开全部时每行显示各自内容', () => {
    render(<Harness calls={readCalls} messages={messages} />);

    click(allButton());

    expect(details()).toHaveLength(2);
    expect(details()[0].textContent).toContain('content of a');
    expect(details()[1].textContent).toContain('content of b');
  });

  test('无结果时回退展示 args', () => {
    render(<Harness calls={[readCalls[0]]} />);

    click(rows()[0]);
    expect(details()[0].textContent).toContain('"offset": 100');
  });
});

describe('FileToolGroupCard edit 行', () => {
  test('优先用结果 details.diff 统计 +N -N', () => {
    const call = fileCall('e1-tool-0', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] });
    render(<Harness calls={[call]} messages={[toolResult('r1', 'edit', 'e1-tool-0', 'ok', { diff: '+1 a\n+2 b\n-1 c' })]} />);

    expect(rows()[0].textContent).toContain('+2');
    expect(rows()[0].textContent).toContain('-1');
  });

  test('展开 edit 行渲染 diff 明细（+/- 行）', () => {
    const call = fileCall('e1-tool-0', 'edit', { path: 'src/a.ts', edits: [{ oldText: 'a\nb', newText: 'a\nc' }] });
    render(<Harness calls={[call]} />);

    click(rows()[0]);
    const lineTypes = [...details()[0].querySelectorAll('[data-testid="diff-line"]')].map((el) =>
      el.getAttribute('data-line-type'),
    );
    expect(lineTypes.filter((t) => t === 'add')).toHaveLength(1);
    expect(lineTypes.filter((t) => t === 'delete')).toHaveLength(1);
  });
});
