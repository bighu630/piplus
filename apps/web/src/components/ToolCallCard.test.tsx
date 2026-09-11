import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import ToolCallCard from './ToolCallCard';

// tool call 卡片展示验收测试：write/edit 摘要（文件 + 增删行数）、read 摘要（文件 + 行号范围）、
// 默认收起与展开/收起切换。setup 模式参照 AskQuestionCard.test.tsx（happy-dom + React 19）。

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

function cleanup() {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
}

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

function toolCallMsg(toolName: string, args: Record<string, unknown>): ChatMessageDTO {
  return {
    id: `call-${toolName}`,
    role: 'assistant',
    message_kind: 'tool_call',
    source_session_id: null,
    content_text: '',
    created_at: new Date().toISOString(),
    tool_name: toolName,
    tool_args_json: JSON.stringify(args),
  };
}

/** 受控 expanded 状态包装，用于验证点击切换。 */
function Harness({ msg, resultDetails }: { msg: ChatMessageDTO; resultDetails?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolCallCard
      msg={msg}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      resultDetails={resultDetails}
    />
  );
}

const meta = () => container!.querySelector('[data-testid="tool-call-meta"]');
const expandedArea = () => container!.querySelector('[data-testid="tool-call-expanded"]');

describe('ToolCallCard write 卡片', () => {
  test('默认收起：头部显示文件与 +N，不渲染 diff 明细，按钮为「展开全部」', () => {
    render(
      <Harness
        msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one\ntwo\nthree' })}
      />,
    );

    expect(meta()).not.toBeNull();
    expect(meta()!.textContent).toContain('src/a.ts');
    expect(meta()!.textContent).toContain('+3');
    expect(expandedArea()).toBeNull();
    expect(findButton('展开全部')).not.toBeNull();
    expect(findButton('收起全部')).toBeNull();

    cleanup();
  });

  test('点击头部展开显示 diff 明细，按钮变「收起全部」；再点击收起', () => {
    render(
      <Harness
        msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one\ntwo\nthree' })}
      />,
    );

    click(findButton('展开全部'));

    expect(expandedArea()).not.toBeNull();
    expect(expandedArea()!.textContent).toContain('one');
    expect(expandedArea()!.textContent).toContain('three');
    expect(findButton('收起全部')).not.toBeNull();

    click(findButton('收起全部'));

    expect(expandedArea()).toBeNull();
    expect(findButton('展开全部')).not.toBeNull();

    cleanup();
  });

  test('点击头部行（非按钮区域）同样切换展开', () => {
    render(
      <Harness
        msg={toolCallMsg('write', { path: 'src/a.ts', content: 'one' })}
      />,
    );

    const header = findButton('展开全部')!.parentElement;
    click(header);

    expect(expandedArea()).not.toBeNull();
    cleanup();
  });

  test('空内容显示 +0', () => {
    render(<Harness msg={toolCallMsg('write', { path: 'src/empty.ts', content: '' })} />);
    expect(meta()!.textContent).toContain('+0');
    cleanup();
  });
});

describe('ToolCallCard edit 卡片', () => {
  test('优先用结果 details.diff 显示 +N -N', () => {
    render(
      <Harness
        msg={toolCallMsg('edit', { path: 'src/c.ts', edits: [{ oldText: 'x', newText: 'y' }] })}
        resultDetails={{ diff: '+1  const a = 1;\n+2  const b = 2;\n-1  const x = 0;' }}
      />,
    );

    expect(meta()!.textContent).toContain('src/c.ts');
    expect(meta()!.textContent).toContain('+2');
    expect(meta()!.textContent).toContain('-1');
    cleanup();
  });

  test('无 details 时回退 args 行级 diff', () => {
    render(
      <Harness
        msg={toolCallMsg('edit', { path: 'src/d.ts', edits: [{ oldText: 'a\nb', newText: 'a\nc' }] })}
      />,
    );

    expect(meta()!.textContent).toContain('+1');
    expect(meta()!.textContent).toContain('-1');
    cleanup();
  });
});

describe('ToolCallCard read 卡片', () => {
  test('显示读取的文件与行号范围', () => {
    render(
      <Harness msg={toolCallMsg('read', { path: 'src/big.ts', offset: 100, limit: 50 })} />,
    );

    expect(meta()!.textContent).toContain('src/big.ts');
    const range = container!.querySelector('[data-testid="tool-call-line-range"]');
    expect(range).not.toBeNull();
    expect(range!.textContent).toBe('100-149');
    cleanup();
  });

  test('无 offset/limit 时只显示文件、不显示行号', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/small.ts' })} />);

    expect(meta()!.textContent).toContain('src/small.ts');
    expect(container!.querySelector('[data-testid="tool-call-line-range"]')).toBeNull();
    cleanup();
  });

  test('仅 offset 显示 100+', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/big.ts', offset: 100 })} />);
    expect(container!.querySelector('[data-testid="tool-call-line-range"]')!.textContent).toBe('100+');
    cleanup();
  });

  test('仅 limit 显示 1-50', () => {
    render(<Harness msg={toolCallMsg('read', { path: 'src/big.ts', limit: 50 })} />);
    expect(container!.querySelector('[data-testid="tool-call-line-range"]')!.textContent).toBe('1-50');
    cleanup();
  });
});

describe('ToolCallCard 其它工具', () => {
  test('bash 无文件摘要，但默认收起且有展开按钮，展开显示 args', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} />);

    expect(meta()).toBeNull();
    expect(expandedArea()).toBeNull();
    click(findButton('展开全部'));
    expect(expandedArea()!.textContent).toContain('echo hi');
    cleanup();
  });
});
