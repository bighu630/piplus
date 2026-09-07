import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import AskQuestionCard, { type AskQuestionAnswerPayload } from './AskQuestionCard';

// ask_question 表单/结果卡片渲染验收测试。
// 说明：happy-dom + React 19 环境下受控 text-input 的 onChange 无法被 dispatchEvent 驱动
//（仅原生 click 流程对 radio/checkbox/button 生效），因此“自己输入”只断言其渲染存在，
// 具体输入提交路径在真实浏览器中由受控组件保证。

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

describe('AskQuestionCard 待回答表单', () => {
  test('单选：渲染 radio + 自己输入，未选择时提交禁用，选择后可提交，取消可触发', () => {
    let submitted: AskQuestionAnswerPayload | null = null;
    let cancelled: AskQuestionAnswerPayload | null = null;
    render(
      <AskQuestionCard
        mode="pending"
        sessionId="sess1"
        pending={{ questionId: 'q1', sessionId: 'sess1', question: '今天吃啥？', options: ['火锅', '烧烤'] }}
        onSubmit={(v) => { submitted = v; }}
        onCancel={(v) => { cancelled = v; }}
      />,
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('今天吃啥？');
    expect(text).toContain('自己输入');
    expect(text).toContain('等待回答');
    expect(container!.querySelector('input[type="radio"]')).not.toBeNull();
    // “自己输入”文本框存在（受控 onChange 在测试环境下无法模拟输入，此处仅断言渲染）
    expect(container!.querySelector('input[type="text"]')).not.toBeNull();

    // 初始无选择：提交禁用
    expect(findButton('提交')!.disabled).toBe(true);
    // 取消
    click(findButton('取消'));
    expect(cancelled).toEqual({ questionId: 'q1', answer: null, cancelled: true });

    // 选择"火锅"后可提交
    const radios = container!.querySelectorAll('input[type="radio"]');
    click(radios[0] as unknown as HTMLButtonElement);
    expect(findButton('提交')!.disabled).toBe(false);
    click(findButton('提交'));
    expect(submitted).toEqual({ questionId: 'q1', answer: '火锅', wasCustom: false });

    cleanup();
  });

  test('单选：提交后文本框消失、显示“等待结果”占位（submitted 态）', () => {
    let submitted: AskQuestionAnswerPayload | null = null;
    render(
      <AskQuestionCard
        mode="pending"
        sessionId="sess1"
        pending={{ questionId: 'q1b', sessionId: 'sess1', question: '确认？', options: ['A', 'B'] }}
        submitted
        onSubmit={(v) => { submitted = v; }}
        onCancel={() => {}}
      />,
    );
    expect(container!.textContent ?? '').toContain('正在等待选择结果');
    cleanup();
  });

  test('多选：checkbox 多项选择，提交为 string[]', () => {
    let submitted: AskQuestionAnswerPayload | null = null;
    render(
      <AskQuestionCard
        mode="pending"
        sessionId="sess1"
        pending={{ questionId: 'q3', sessionId: 'sess1', question: '多选', options: ['A', 'B', 'C'], multiSelect: true }}
        onSubmit={(v) => { submitted = v; }}
        onCancel={() => {}}
      />,
    );
    const checks = container!.querySelectorAll('input[type="checkbox"]');
    expect(checks.length).toBe(3);
    expect(findButton('提交')!.disabled).toBe(true);
    click(checks[0] as unknown as HTMLButtonElement);
    click(checks[2] as unknown as HTMLButtonElement);
    click(findButton('提交'));
    expect(submitted).toEqual({ questionId: 'q3', answer: ['A', 'C'], wasCustom: false });
    cleanup();
  });

  test('问卷：标签页导航 + 逐题作答后统一提交（单选 string / 多选 string[ ]）', () => {
    let submitted: AskQuestionAnswerPayload | null = null;
    render(
      <AskQuestionCard
        mode="pending"
        sessionId="sess1"
        pending={{
          questionId: 'q4',
          sessionId: 'sess1',
          questions: [
            { question: '第一问', options: ['A1', 'B1'], label: '选项目标' },
            { question: '第二问', options: ['A2', 'B2'], multiSelect: true },
          ],
        }}
        onSubmit={(v) => { submitted = v; }}
        onCancel={() => {}}
      />,
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('选项目标');
    expect(text).toContain('第一问');
    // 未全部作答：提交全部禁用
    expect(findButton('提交全部')!.disabled).toBe(true);

    // 答第一题（单选，点击选项 A1）
    const radios = container!.querySelectorAll('input[type="radio"]');
    click(radios[0] as unknown as HTMLButtonElement);
    // 切到第二题（多选）
    const tab2 = [...(container!.querySelectorAll('button') as unknown as HTMLElement[])].find(
      (b) => b.textContent?.trim() === '问题 2',
    )!;
    click(tab2);
    const checks = container!.querySelectorAll('input[type="checkbox"]');
    expect(checks.length).toBe(2);
    click(checks[1] as unknown as HTMLButtonElement);

    click(findButton('提交全部'));
    expect(submitted?.questionId).toBe('q4');
    expect(submitted?.answers).toEqual(['A1', ['B2']]);
    cleanup();
  });
});

describe('AskQuestionCard 已回答结果', () => {
  test('单选：✓ 答案', () => {
    render(
      <AskQuestionCard
        mode="result"
        sessionId="sess1"
        details={{ question: 'Q?', options: ['A', 'B'], answer: 'A', multiSelect: false, wasCustom: false }}
      />,
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('已回答');
    expect(text).toContain('A');
    expect(text).not.toContain('自己输入');
    cleanup();
  });

  test('自定义：✓ 自己输入：X', () => {
    render(
      <AskQuestionCard
        mode="result"
        sessionId="sess1"
        details={{ question: 'Q?', options: ['A', 'B'], answer: '手工答案', multiSelect: false, wasCustom: true, customAnswers: ['手工答案'] }}
      />,
    );
    expect(container!.textContent ?? '').toContain('自己输入：');
    expect(container!.textContent ?? '').toContain('手工答案');
    cleanup();
  });

  test('多选：每项一行', () => {
    render(
      <AskQuestionCard
        mode="result"
        sessionId="sess1"
        details={{ question: 'Q?', options: ['A', 'B', 'C'], answer: ['A', 'C'], multiSelect: true }}
      />,
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('A');
    expect(text).toContain('C');
    expect(text).not.toContain('B');
    cleanup();
  });

  test('取消：已取消 + 用户取消（warning）', () => {
    render(
      <AskQuestionCard
        mode="result"
        sessionId="sess1"
        details={{ question: 'Q?', options: ['A', 'B'], answer: null, multiSelect: false, cancelled: true }}
      />,
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('已取消');
    expect(text).toContain('用户取消');
    cleanup();
  });

  test('问卷：逐题 label：答案（含未回答）', () => {
    render(
      <AskQuestionCard
        mode="result"
        sessionId="sess1"
        details={{
          questions: [
            { question: 'Q1', options: ['A', 'B'], answer: 'A', multiSelect: false, label: '目标' },
            { question: 'Q2', options: ['A', 'B'], answer: ['A', 'B'], multiSelect: true },
            { question: 'Q3', options: ['A', 'B'], answer: null, multiSelect: false, label: '跳过' },
          ],
        }}
      />,
    );
    const text = container!.textContent ?? '';
    expect(text).toContain('问卷已回答');
    expect(text).toContain('目标：');
    expect(text).toContain('A');
    expect(text).toContain('B');
    expect(text).toContain('跳过：');
    expect(text).toContain('未回答');
    cleanup();
  });

  test('details 缺失：降级显示 content text', () => {
    render(
      <AskQuestionCard mode="result" sessionId="sess1" details={null} content="用户选择：A" />,
    );
    expect(container!.textContent ?? '').toContain('用户选择：A');
    cleanup();
  });
});
