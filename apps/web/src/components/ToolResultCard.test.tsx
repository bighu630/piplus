import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React, { useState } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { ChatMessageDTO } from '@piplus/shared';
import ToolResultCard from './ToolResultCard';

// 独立结果卡片（ask_question 之外、结果不落在工具调用卡片内的结果消息）验收测试：
// - 默认展开（无需点击即显示正文）
// - 点击头部可收起，再点击可展开；键盘 Enter/Space 同样可切换
// - spawn_session / send_message_to_session 的 summary 走 Markdown 紫色卡；失败红 / 普通绿

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { navigator?: unknown }).navigator = originalNavigator;
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
    (el as HTMLElement).click();
  });
}

const header = () => container!.querySelector('[data-testid="standalone-result-header"]');
const body = () => container!.querySelector('[data-testid="standalone-result-body"]');
const status = () => container!.querySelector('[data-testid="standalone-result-status"]');
const card = () => container!.querySelector('[data-testid="standalone-result-card"]');

/** 与 TabChat 同口径的受控折叠态：默认展开，记「已收起」的 id */
function Harness({ msg }: { msg: ChatMessageDTO }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  return <ToolResultCard msg={msg} expanded={!collapsed.has(msg.id)} onToggle={toggle} />;
}

function resultMsg(toolName: string, contentText: string | null): ChatMessageDTO {
  return {
    id: `res-${toolName}`,
    role: 'tool',
    message_kind: 'tool',
    source_session_id: null,
    content_text: contentText,
    created_at: new Date().toISOString(),
    tool_name: toolName,
  } as ChatMessageDTO;
}

const spawnResult = (status: string | undefined, summary = 'all done') =>
  JSON.stringify(status === undefined ? { summary } : { status, summary });

describe('ToolResultCard 默认展开与收起', () => {
  test('默认展开：无需点击即渲染正文，aria-expanded 为 true', () => {
    render(<Harness msg={resultMsg('spawn_session', spawnResult('completed', '# 报告\n\n正文内容'))} />);

    expect(header()!.getAttribute('aria-expanded')).toBe('true');
    expect(body()).not.toBeNull();
    expect(body()!.textContent).toContain('正文内容');
  });

  test('点击头部收起，再点击展开', () => {
    render(<Harness msg={resultMsg('send_message_to_session', spawnResult('completed', '子会话结果'))} />);
    expect(body()).not.toBeNull();

    click(header());
    expect(body()).toBeNull();
    expect(header()!.getAttribute('aria-expanded')).toBe('false');
    // 收起后头部信息保留（工具名 + 状态）
    expect(header()!.textContent).toContain('send_message_to_session');
    expect(status()!.textContent).toBe('完成');

    click(header());
    expect(body()).not.toBeNull();
    expect(header()!.getAttribute('aria-expanded')).toBe('true');
    expect(body()!.textContent).toContain('子会话结果');
  });

  test('头部支持键盘 Enter / Space 切换', () => {
    render(<Harness msg={resultMsg('spawn_session', spawnResult('completed'))} />);

    act(() => {
      header()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(body()).toBeNull();

    act(() => {
      header()!.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    });
    expect(body()).not.toBeNull();
  });

  test('头部可键盘聚焦（role=button + tabIndex）', () => {
    render(<Harness msg={resultMsg('spawn_session', spawnResult('completed'))} />);
    expect(header()!.getAttribute('role')).toBe('button');
    expect(header()!.getAttribute('tabindex')).toBe('0');
  });
});

describe('ToolResultCard 配色与内容口径', () => {
  test('spawn_session 摘要：紫色卡 + Markdown 渲染 + 「完成」状态', () => {
    render(<Harness msg={resultMsg('spawn_session', spawnResult('completed', '# 标题\n\n- 条目'))} />);

    expect(card()!.className).toContain('bg-indigo-50');
    expect(card()!.className).toContain('dark:bg-indigo-950/30');
    expect(status()!.textContent).toBe('完成');
    expect(body()!.querySelector('h1')!.textContent).toBe('标题');
    expect(body()!.querySelector('li')!.textContent).toBe('条目');
  });

  test('spawn_session 其它状态：原样展示状态文案', () => {
    render(<Harness msg={resultMsg('spawn_session', spawnResult('running'))} />);
    expect(status()!.textContent).toBe('running');
    expect(card()!.className).toContain('bg-indigo-50');
  });

  test('spawn_session 无 status：不渲染状态文案，正文照常展开', () => {
    render(<Harness msg={resultMsg('spawn_session', spawnResult(undefined, '无状态摘要'))} />);
    expect(status()).toBeNull();
    expect(body()!.textContent).toContain('无状态摘要');
  });

  test('失败结果：红色卡 + 「错误」状态 + 正文', () => {
    render(<Harness msg={resultMsg('spawn_session', 'Error: spawn failed badly')} />);

    expect(card()!.className).toContain('bg-rose-50');
    expect(status()!.textContent).toBe('错误');
    expect(body()!.textContent).toContain('Error: spawn failed badly');
  });

  test('spawn 结果不是 JSON：降级为普通绿色卡 + 200 字截断', () => {
    const longText = 'x'.repeat(300);
    render(<Harness msg={resultMsg('spawn_session', longText)} />);

    expect(card()!.className).toContain('bg-emerald-50');
    expect(status()!.textContent).toBe('结果');
    expect(body()!.textContent).toContain('…');
    expect(body()!.textContent!.length).toBeLessThan(260);
  });

  test('普通结果截断边界：恰好 200 字不截断', () => {
    const exactly200 = 'y'.repeat(200);
    render(<Harness msg={resultMsg('bash', exactly200)} />);
    expect(body()!.textContent).toBe(exactly200);
  });

  test('普通结果截断边界：201 字截断到 200 字加省略号', () => {
    const over200 = 'z'.repeat(201);
    render(<Harness msg={resultMsg('bash', over200)} />);
    expect(body()!.textContent).toBe(`${'z'.repeat(200)}…`);
  });

  test('summary 为空串：不按摘要卡渲染', () => {
    render(<Harness msg={resultMsg('spawn_session', JSON.stringify({ summary: '   ', status: 'completed' }))} />);

    expect(card()!.className).toContain('bg-emerald-50');
    // 无 summary 时状态文案退化为「结果」（与既有口径一致）
    expect(status()!.textContent).toBe('结果');
  });

  test('孤立结果（普通工具）：绿色卡 + 「结果」状态', () => {
    render(<Harness msg={resultMsg('bash', 'orphan output')} />);

    expect(card()!.className).toContain('bg-emerald-50');
    expect(status()!.textContent).toBe('结果');
    expect(body()!.textContent).toContain('orphan output');
    expect(header()!.textContent).toContain('bash');
  });

  test('空内容：头部显示「结果」且不渲染正文（收起前后一致）', () => {
    render(<Harness msg={resultMsg('bash', null)} />);

    expect(status()!.textContent).toBe('结果');
    expect(body()).toBeNull();

    click(header());
    click(header());
    expect(body()).toBeNull();
  });

  test('空字符串内容：与无内容一致，不渲染正文', () => {
    render(<Harness msg={resultMsg('bash', '')} />);

    expect(status()!.textContent).toBe('结果');
    expect(body()).toBeNull();
    expect(card()!.className).toContain('bg-emerald-50');
  });

  test('工具名缺失：回退 unknown，卡片仍可用', () => {
    render(<Harness msg={resultMsg('', 'plain')} />);
    expect(header()!.textContent).toContain('unknown');
    expect(body()).not.toBeNull();
  });
});
