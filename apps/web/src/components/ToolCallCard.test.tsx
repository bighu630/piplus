import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import ToolCallCard from './ToolCallCard';

// 单条工具调用卡片（非文件类）验收测试：
// - 展开后两个可折叠子项：「执行参数」默认收起、「结果」默认展开（成功/失败/运行中）
// - 例外保持现状：spawn_session / send_message_to_session（args 表格）、ask_question（JSON args）

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

function Harness({
  msg,
  resultContent,
  roleSuffix,
  running,
}: {
  msg: ChatMessageDTO;
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
      resultContent={resultContent}
      roleSuffix={roleSuffix}
      running={running}
    />
  );
}

const header = () => container!.querySelector('[data-testid="tool-call-header"]');
const expandedArea = () => container!.querySelector('[data-testid="tool-call-expanded"]');
const argsToggle = () => container!.querySelector('[data-testid="tool-args-toggle"]');
const argsContent = () => container!.querySelector('[data-testid="tool-args-content"]');
const resultToggle = () => container!.querySelector('[data-testid="tool-result-toggle"]');
const resultContent = () => container!.querySelector('[data-testid="tool-result-content"]');
const resultStatus = () => container!.querySelector('[data-testid="tool-result-status"]');

describe('ToolCallCard 普通工具（两个子项）', () => {
  test('默认收起；点击头部展开后出现「执行参数」与「结果」两个子项', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} resultContent={'hi'} />);

    expect(expandedArea()).toBeNull();

    click(header());

    expect(expandedArea()).not.toBeNull();
    expect(argsToggle()!.textContent).toContain('执行参数');
    expect(resultToggle()!.textContent).toContain('结果');
  });

  test('执行参数默认收起，点击后显示 args，再点击收起', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} resultContent={'hi'} />);
    click(header());

    expect(argsContent()).toBeNull();

    click(argsToggle());
    expect(argsContent()!.textContent).toContain('echo hi');

    click(argsToggle());
    expect(argsContent()).toBeNull();
  });

  test('结果默认展开：显示内容与「成功」标识', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} resultContent={'hi'} />);
    click(header());

    expect(resultStatus()!.textContent).toBe('成功');
    expect(resultContent()).not.toBeNull();
    expect(resultContent()!.textContent).toContain('hi');
  });

  test('失败结果：红色「失败」标识 + 错误内容', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'false' })} resultContent={'Error: exit code 1'} />);
    click(header());

    expect(resultStatus()!.textContent).toBe('失败');
    expect(resultContent()!.querySelector('pre')!.className).toContain('text-rose-700');
    expect(resultContent()!.textContent).toContain('exit code 1');
  });

  test('结果未回：显示「运行中」与执行中占位', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'sleep 1' })} running />);
    click(header());

    expect(resultStatus()!.textContent).toBe('运行中');
    expect(resultContent()!.textContent).toContain('执行中');
  });

  test('结果子项可收起', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} resultContent={'hi'} />);
    click(header());
    expect(resultContent()).not.toBeNull();

    click(resultToggle());
    expect(resultContent()).toBeNull();
  });

  test('重新展开主卡片时子项恢复默认（参数收起、结果展开）', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'echo hi' })} resultContent={'hi'} />);
    click(header());
    click(argsToggle()); // 参数展开
    click(resultToggle()); // 结果收起
    expect(argsContent()).not.toBeNull();
    expect(resultContent()).toBeNull();

    click(header()); // 收起主卡片
    click(header()); // 重新展开

    expect(argsContent()).toBeNull();
    expect(resultContent()).not.toBeNull();
  });
});

describe('ToolCallCard 例外工具保持现状', () => {
  test('spawn_session：角色后缀 + args 表格（无子项）', () => {
    render(
      <Harness
        msg={toolCallMsg('spawn_session', { role: 'worker', objective: 'do work' })}
        roleSuffix="worker"
        resultContent={'{"summary":"done"}'}
      />,
    );

    expect(header()!.textContent).toContain('spawn_session (worker)');

    click(header());

    expect(expandedArea()!.querySelector('table')).not.toBeNull();
    expect(expandedArea()!.textContent).toContain('do work');
    expect(argsToggle()).toBeNull();
    expect(resultToggle()).toBeNull();
  });

  test('ask_question：JSON args（无子项）', () => {
    render(<Harness msg={toolCallMsg('ask_question', { question: 'q' })} />);

    click(header());

    expect(expandedArea()!.textContent).toContain('"question"');
    expect(argsToggle()).toBeNull();
  });

  test('args JSON 非法：展开「执行参数」显示原始文本', () => {
    render(<Harness msg={toolCallMsg('bash', '{invalid json')} />);
    click(header());
    click(argsToggle());

    expect(argsContent()!.textContent).toContain('{invalid json');
  });

  test('无 args：执行参数子项显示「（无参数）」', () => {
    render(<Harness msg={toolCallMsg('bash', '')} />);
    click(header());
    click(argsToggle());

    expect(argsContent()!.textContent).toContain('（无参数）');
  });

  test('运行中：头部右侧渲染 spinner', () => {
    render(<Harness msg={toolCallMsg('bash', { command: 'sleep 1' })} running />);
    expect(container!.querySelector('.animate-spin')).not.toBeNull();
  });
});
