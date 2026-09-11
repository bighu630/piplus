import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import ToolCallCard from './ToolCallCard';

// 单条工具调用卡片（非文件类）验收测试：头部 chevron + 工具名，点击展开/收起 args。
// write/edit/read 由 FileToolGroupCard 覆盖（见 FileToolGroupCard.test.tsx）。

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

function Harness({ msg, roleSuffix, running }: { msg: ChatMessageDTO; roleSuffix?: string | null; running?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <ToolCallCard
      msg={msg}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      roleSuffix={roleSuffix}
      running={running}
    />
  );
}

const header = () => container!.querySelector('[data-testid="tool-call-header"]');
const expandedArea = () => container!.querySelector('[data-testid="tool-call-expanded"]');

describe('ToolCallCard（非文件类工具）', () => {
  test('bash：无摘要行、无按钮，默认收起，点击头部展开 args', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} />);

    expect(header()!.textContent).toContain('bash');
    expect(container!.querySelectorAll('button')).toHaveLength(0);
    expect(container!.querySelector('[data-testid="tool-call-meta"]')).toBeNull();
    expect(expandedArea()).toBeNull();

    click(header());
    expect(expandedArea()!.textContent).toContain('echo hi');

    click(header());
    expect(expandedArea()).toBeNull();
  });

  test('spawn_session：头部显示角色后缀，展开为 args 表格', () => {
    render(<Harness msg={toolCallMsg('spawn_session', { role: 'worker', objective: 'do work' })} roleSuffix="worker" />);

    expect(header()!.textContent).toContain('spawn_session (worker)');
    expect(expandedArea()).toBeNull();

    click(header());
    expect(expandedArea()!.querySelector('table')).not.toBeNull();
    expect(expandedArea()!.textContent).toContain('do work');
  });

  test('args JSON 非法时降级展示原始文本', () => {
    render(<Harness msg={toolCallMsg('bash', '{invalid json')} />);

    click(header());
    expect(expandedArea()!.textContent).toContain('{invalid json');
  });

  test('无 args 时展开不渲染内容区', () => {
    render(<Harness msg={toolCallMsg('bash', '')} />);

    click(header());
    expect(expandedArea()).toBeNull();
  });

  test('running 时渲染 spinner', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'sleep 1' })} running />);
    expect(container!.querySelector('.animate-spin')).not.toBeNull();
  });
});
