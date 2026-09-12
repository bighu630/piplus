import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import MergedToolCallsCard from './MergedToolCallsCard';

// 连续同工具调用的合并卡片验收测试：
// 头部 ×N、展开为多组「执行参数（默认收起）+ 结果（默认展开）」、组间分割、重新展开恢复默认、键盘可达。

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

function pressKey(el: Element | null, key: string) {
  act(() => {
    el!.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  });
}

function toolCall(id: string, toolName: string, args: Record<string, unknown>): ChatMessageDTO {
  return {
    id,
    role: 'assistant',
    message_kind: 'tool_call',
    source_session_id: null,
    content_text: '',
    created_at: new Date().toISOString(),
    tool_name: toolName,
    tool_args_json: JSON.stringify(args),
    tool_call_id: id,
  };
}

function toolResult(id: string, toolName: string, callId: string, content: string): ChatMessageDTO {
  return {
    id,
    role: 'tool',
    message_kind: 'tool',
    source_session_id: null,
    content_text: content,
    created_at: new Date().toISOString(),
    tool_name: toolName,
    tool_call_id: callId,
  };
}

const threeCalls = () => [
  toolCall('c1', 'bash', { command: 'echo 1' }),
  toolCall('c2', 'bash', { command: 'echo 2' }),
  toolCall('c3', 'bash', { command: 'echo 3' }),
];

const threeResults = [
  toolResult('r1', 'bash', 'c1', 'out 1'),
  toolResult('r2', 'bash', 'c2', 'out 2'),
  toolResult('r3', 'bash', 'c3', 'out 3'),
];

const messages = [...threeCalls(), ...threeResults];

function Harness({
  calls,
  msgs,
  runningIds,
}: {
  calls: ChatMessageDTO[];
  msgs: ChatMessageDTO[];
  runningIds?: Set<string>;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <MergedToolCallsCard
      toolName={calls[0].tool_name || 'unknown'}
      calls={calls}
      messages={msgs}
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
      runningIds={runningIds ?? new Set()}
    />
  );
}

const header = () => container!.querySelector('[data-testid="merged-tool-header"]');
const count = () => container!.querySelector('[data-testid="merged-tool-count"]');
const entries = () => [...container!.querySelectorAll('[data-testid="merged-tool-entry"]')];
const argsToggles = () => [...container!.querySelectorAll('[data-testid="tool-args-toggle"]')];
const argsContents = () => [...container!.querySelectorAll('[data-testid="tool-args-content"]')];
const resultContents = () => [...container!.querySelectorAll('[data-testid="tool-result-content"]')];

describe('MergedToolCallsCard', () => {
  test('头部显示工具名与 ×N，默认收起且为成功配色', () => {
    render(<Harness calls={threeCalls()} msgs={messages} />);

    expect(header()!.textContent).toContain('bash');
    expect(count()!.textContent).toBe('×3');
    expect(entries()).toHaveLength(0);
    expect(container!.querySelector('[data-testid="merged-tool-card"]')!.getAttribute('data-status')).toBe('ok');
    expect(container!.querySelector('.bg-emerald-50')).not.toBeNull();
  });

  test('展开为 N 组：参数默认收起、结果默认展开且各自内容正确', () => {
    render(<Harness calls={threeCalls()} msgs={messages} />);

    click(header());

    expect(entries()).toHaveLength(3);
    expect(argsToggles()).toHaveLength(3);
    expect(argsContents()).toHaveLength(0);
    expect(resultContents()).toHaveLength(3);
    expect(resultContents()[0].textContent).toContain('out 1');
    expect(resultContents()[2].textContent).toContain('out 3');
  });

  test('组间以分割线与间隙隔开（首组无间隙）', () => {
    render(<Harness calls={threeCalls()} msgs={messages} />);
    click(header());

    const list = entries();
    expect(list[0].className).toContain('border-t');
    expect(list[0].className).not.toContain('mt-1');
    expect(list[1].className).toContain('border-t');
    expect(list[1].className).toContain('mt-1');
  });

  test('每组参数可独立展开', () => {
    render(<Harness calls={threeCalls()} msgs={messages} />);
    click(header());

    click(argsToggles()[1]);

    expect(argsContents()).toHaveLength(1);
    expect(argsContents()[0].textContent).toContain('echo 2');
  });

  test('重新展开卡片时子项恢复默认', () => {
    render(<Harness calls={threeCalls()} msgs={messages} />);
    click(header());
    click(argsToggles()[0]);
    expect(argsContents()).toHaveLength(1);

    click(header()); // 收起
    click(header()); // 重新展开

    expect(argsContents()).toHaveLength(0);
    expect(resultContents()).toHaveLength(3);
  });

  test('键盘可达（Enter 展开 / Space 收起）', () => {
    render(<Harness calls={threeCalls()} msgs={messages} />);

    pressKey(header(), 'Enter');
    expect(entries()).toHaveLength(3);

    pressKey(header(), ' ');
    expect(entries()).toHaveLength(0);
  });

  test('running 调用渲染 spinner', () => {
    render(<Harness calls={threeCalls()} msgs={messages} runningIds={new Set(['c2'])} />);
    expect(container!.querySelector('.animate-spin')).not.toBeNull();
  });

  test('×2 合并组同样工作', () => {
    render(<Harness calls={threeCalls().slice(0, 2)} msgs={messages} />);
    expect(count()!.textContent).toBe('×2');

    click(header());
    expect(entries()).toHaveLength(2);
  });
});
