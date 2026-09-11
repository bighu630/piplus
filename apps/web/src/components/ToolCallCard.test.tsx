import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import ToolCallCard from './ToolCallCard';

// tool call 卡片展示验收测试。
// 结构约定：头部只有 chevron + 工具名（点击切换）；write/edit/read 在头部下方常显文件摘要行，
// 行内与「展开全部/收起全部」按钮均可切换；其它工具保持原交互（头部点开 args、无摘要无按钮）。

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

function findButton(text: string): HTMLButtonElement | null {
  return [...(container!.querySelectorAll('button') as unknown as HTMLButtonElement[])].find(
    (b) => b.textContent?.trim() === text,
  ) ?? null;
}

function click(el: Element | null) {
  act(() => {
    (el as HTMLButtonElement).click();
  });
}

function toolCallMsg(toolName: string, args: Record<string, unknown> | string): ChatMessageDTO {
  return {
    id: `call-${toolName}`,
    role: 'assistant',
    message_kind: 'tool_call',
    source_session_id: null,
    content_text: '',
    created_at: new Date().toISOString(),
    tool_name: toolName,
    tool_args_json: typeof args === 'string' ? args : JSON.stringify(args),
  };
}

/** 受控 expanded 状态包装，用于验证点击切换。 */
function Harness({
  msg,
  resultDetails,
  resultContent,
  roleSuffix,
  running,
}: {
  msg: ChatMessageDTO;
  resultDetails?: unknown;
  resultContent?: string | null;
  roleSuffix?: string | null;
  running?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolCallCard
      msg={msg}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      resultDetails={resultDetails}
      resultContent={resultContent}
      roleSuffix={roleSuffix}
      running={running}
    />
  );
}

const header = () => container!.querySelector('.cursor-pointer.select-none');
const meta = () => container!.querySelector('[data-testid="tool-call-meta"]');
const expandedArea = () => container!.querySelector('[data-testid="tool-call-expanded"]');
const diffLines = () => [...container!.querySelectorAll('[data-testid="diff-line"]')];
const diffLinesOfType = (type: string) =>
  diffLines().filter((el) => el.getAttribute('data-line-type') === type);

describe('ToolCallCard write 卡片', () => {
  test('默认收起：头部只有工具名（无按钮），下方摘要行显示文件与 +N', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one\ntwo\nthree' })} />);

    expect(header()!.textContent).toContain('write');
    expect(header()!.textContent).not.toContain('src/a.ts');
    expect(meta()).not.toBeNull();
    expect(meta()!.textContent).toContain('src/a.ts');
    expect(meta()!.textContent).toContain('+3');
    expect(expandedArea()).toBeNull();
    expect(diffLines()).toHaveLength(0);
    expect(findButton('展开全部')).not.toBeNull();
    expect(findButton('收起全部')).toBeNull();
  });

  test('点击头部展开显示 diff 明细，按钮变「收起全部」；再点击收起', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one\ntwo\nthree' })} />);

    click(header());

    expect(expandedArea()).not.toBeNull();
    expect(diffLines()).toHaveLength(3);
    expect(diffLinesOfType('add')).toHaveLength(3);
    expect(findButton('收起全部')).not.toBeNull();

    click(header());

    expect(expandedArea()).toBeNull();
    expect(findButton('展开全部')).not.toBeNull();
  });

  test('点击文件摘要行同样切换展开', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one' })} />);

    click(meta());

    expect(expandedArea()).not.toBeNull();
  });

  test('点击「展开全部」按钮切换，且不触发双重切换', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one' })} />);

    click(findButton('展开全部'));

    expect(expandedArea()).not.toBeNull();
    expect(findButton('收起全部')).not.toBeNull();
  });

  test('空内容显示 +0', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/empty.ts', content: '' })} />);
    expect(meta()!.textContent).toContain('+0');
  });

  test('末尾换行内容：头部 +N 与展开明细行数一致（不多出空行）', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/a.ts', content: 'a\nb\n' })} />);

    expect(meta()!.textContent).toContain('+2');
    click(meta());
    expect(diffLines()).toHaveLength(2);
    expect(diffLinesOfType('add')).toHaveLength(2);
  });

  test('缺少 path 时显示占位符但保留行数', () => {
    render(<Harness msg={toolCallMsg('write', { content: 'a\nb' })} />);
    expect(meta()!.textContent).toContain('(未提供路径)');
    expect(meta()!.textContent).toContain('+2');
  });
});

describe('ToolCallCard edit 卡片', () => {
  test('默认收起，摘要行优先用结果 details.diff 显示 +N -N', () => {
    render(
      <Harness
        msg={toolCallMsg('edit', { path: 'src/c.ts', edits: [{ oldText: 'x', newText: 'y' }] })}
        resultDetails={{ diff: '+1  const a = 1;\n+2  const b = 2;\n-1  const x = 0;' }}
      />,
    );

    expect(expandedArea()).toBeNull();
    expect(meta()!.textContent).toContain('src/c.ts');
    expect(meta()!.textContent).toContain('+2');
    expect(meta()!.textContent).toContain('-1');
  });

  test('无 details 时回退 args 行级 diff', () => {
    render(
      <Harness
        msg={toolCallMsg('edit', { path: 'src/d.ts', edits: [{ oldText: 'a\nb', newText: 'a\nc' }] })}
      />,
    );

    expect(meta()!.textContent).toContain('+1');
    expect(meta()!.textContent).toContain('-1');
  });

  test('纯删除只显示 -N（不出现 +0）', () => {
    render(<Harness msg={toolCallMsg('edit', { path: 'src/e.ts', edits: [{ oldText: 'a\nb', newText: '' }] })} />);

    expect(meta()!.textContent).not.toContain('+0');
    expect(meta()!.textContent).toContain('-2');
  });

  test('展开后渲染 edit diff 明细（+/- 行）', () => {
    render(
      <Harness
        msg={toolCallMsg('edit', { path: 'src/f.ts', edits: [{ oldText: 'a\nb', newText: 'a\nc' }] })}
      />,
    );

    click(meta());
    expect(diffLinesOfType('add')).toHaveLength(1);
    expect(diffLinesOfType('delete')).toHaveLength(1);
  });
});

describe('ToolCallCard read 卡片', () => {
  test('默认收起，摘要行显示读取的文件与行号范围', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/big.ts', offset: 100, limit: 50 })} />);

    expect(header()!.textContent).toContain('read');
    expect(expandedArea()).toBeNull();
    expect(meta()!.textContent).toContain('src/big.ts');
    const range = container!.querySelector('[data-testid="tool-call-line-range"]');
    expect(range!.textContent).toBe('100-149');
  });

  test('无 offset/limit 时只显示文件、不显示行号', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/small.ts' })} />);

    expect(meta()!.textContent).toContain('src/small.ts');
    expect(container!.querySelector('[data-testid="tool-call-line-range"]')).toBeNull();
  });

  test('仅 offset 显示 100+', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/big.ts', offset: 100 })} />);
    expect(container!.querySelector('[data-testid="tool-call-line-range"]')!.textContent).toBe('100+');
  });

  test('仅 limit 显示 1-50', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/big.ts', limit: 50 })} />);
    expect(container!.querySelector('[data-testid="tool-call-line-range"]')!.textContent).toBe('1-50');
  });

  test('展开显示读取到的内容（不带行号）', () => {
    render(
      <Harness
        msg={toolCallMsg('read', { path: 'src/big.ts', offset: 100, limit: 2 })}
        resultContent={'const a = 1;\nconst b = 2;'}
      />,
    );

    click(meta());

    expect(expandedArea()).not.toBeNull();
    expect(expandedArea()!.textContent).toContain('const a = 1;');
    expect(expandedArea()!.textContent).toContain('const b = 2;');
    // 内容区不带行号前缀，行号只出现在摘要 range
    expect(expandedArea()!.textContent).not.toContain('100');
  });

  test('无结果内容时回退展示 args', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/big.ts', offset: 100, limit: 50 })} />);

    click(meta());

    expect(expandedArea()!.textContent).toContain('"offset": 100');
  });

  test('超长内容截断到 500 行并提示', () => {
    const content = Array.from({ length: 620 }, (_, i) => `line ${i}`).join('\n');
    render(<Harness msg={toolCallMsg('read', { path: 'src/huge.ts' })} resultContent={content} />);

    click(meta());

    const pre = expandedArea()!.querySelector('pre')!;
    expect(pre.textContent!.split('\n')).toHaveLength(500);
    expect(expandedArea()!.textContent).toContain('仅显示前 500 行（共 620 行）');
  });
});

describe('ToolCallCard 其它工具与降级', () => {
  test('bash 无摘要行、无按钮，点击头部展开 args', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} />);

    expect(meta()).toBeNull();
    expect(findButton('展开全部')).toBeNull();
    expect(findButton('收起全部')).toBeNull();
    expect(expandedArea()).toBeNull();

    click(header());
    expect(expandedArea()!.textContent).toContain('echo hi');
  });

  test('spawn_session：角色后缀在头部，无摘要行，点击头部展开 args 表格', () => {
    render(
      <Harness
        msg={toolCallMsg('spawn_session', { role: 'worker', objective: 'do work' })}
        roleSuffix="worker"
      />,
    );

    expect(header()!.textContent).toContain('spawn_session (worker)');
    expect(meta()).toBeNull();
    expect(expandedArea()).toBeNull();

    click(header());
    expect(expandedArea()!.querySelector('table')).not.toBeNull();
    expect(expandedArea()!.textContent).toContain('do work');
  });

  test('args JSON 非法时降级展示原始文本', () => {
    render(<Harness msg={toolCallMsg('write', '{invalid json')} />);

    expect(meta()).toBeNull();
    click(header());
    expect(expandedArea()!.textContent).toContain('{invalid json');
  });

  test('running 时渲染 spinner', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'sleep 1' })} running />);
    expect(container!.querySelector('.animate-spin')).not.toBeNull();
  });
});
