import { afterAll, describe, expect, test } from 'bun:test';
import {
  askNotificationBody,
  isWindowFocused,
  shouldNotifyAsk,
  stripAskTitle,
  withAskTitle,
} from './ask-notify';

describe('shouldNotifyAsk（触发条件：会话非激活 或 窗口失焦）', () => {
  test('会话不是当前激活会话 → 通知（即使窗口聚焦）', () => {
    expect(shouldNotifyAsk({ sessionId: 's2', activeSessionId: 's1', hasFocus: true })).toBe(true);
  });

  test('窗口失焦 → 通知（即使是当前激活会话）', () => {
    expect(shouldNotifyAsk({ sessionId: 's1', activeSessionId: 's1', hasFocus: false })).toBe(true);
  });

  test('两者都满足 → 通知', () => {
    expect(shouldNotifyAsk({ sessionId: 's2', activeSessionId: 's1', hasFocus: false })).toBe(true);
  });

  test('当前激活会话 + 窗口聚焦 → 不打扰', () => {
    expect(shouldNotifyAsk({ sessionId: 's1', activeSessionId: 's1', hasFocus: true })).toBe(false);
  });

  test('无 sessionId → 不通知（无法跳转）', () => {
    expect(shouldNotifyAsk({ sessionId: undefined, activeSessionId: null, hasFocus: false })).toBe(false);
    expect(shouldNotifyAsk({ sessionId: '', activeSessionId: 's1', hasFocus: false })).toBe(false);
  });

  test('未选中任何会话（activeSessionId=null）→ 通知', () => {
    expect(shouldNotifyAsk({ sessionId: 's1', activeSessionId: null, hasFocus: true })).toBe(true);
  });
});

describe('askNotificationBody', () => {
  test('单题：返回问题原文', () => {
    expect(askNotificationBody({ questionId: 'q1', question: '要用哪个数据库？', options: ['A'] }))
      .toBe('要用哪个数据库？');
  });

  test('问卷：题量 + 首题', () => {
    expect(askNotificationBody({
      questionId: 'q2',
      questions: [
        { question: '数据库选哪个？', options: ['A'] },
        { question: '端口用多少？', options: ['B'] },
      ],
    })).toBe('共 2 个问题待回答：数据库选哪个？');
  });

  test('换行折叠 + 超长截断', () => {
    const body = askNotificationBody({ questionId: 'q3', question: `第一行\n第二行${'x'.repeat(200)}` });
    expect(body).not.toContain('\n');
    expect(body.length).toBeLessThanOrEqual(120);
    expect(body.endsWith('…')).toBe(true);
  });

  test('内容缺失 / 全空白 → 兜底文案', () => {
    expect(askNotificationBody({ questionId: 'q4' })).toBe('Agent 正在等待你的回答');
    expect(askNotificationBody({ questionId: 'q5', question: '   ' })).toBe('Agent 正在等待你的回答');
  });
});

describe('withAskTitle / stripAskTitle', () => {
  test('有 pending 加前缀，无 pending 还原', () => {
    expect(withAskTitle('PiPlus', 0)).toBe('PiPlus');
    expect(withAskTitle('PiPlus', 1)).toBe('(1 条待回答) PiPlus');
    expect(withAskTitle('PiPlus', 3)).toBe('(3 条待回答) PiPlus');
  });

  test('stripAskTitle 可还原且幂等，不误伤普通标题', () => {
    expect(stripAskTitle('(2 条待回答) PiPlus')).toBe('PiPlus');
    expect(stripAskTitle(stripAskTitle('(2 条待回答) PiPlus'))).toBe('PiPlus');
    expect(stripAskTitle('PiPlus')).toBe('PiPlus');
    expect(stripAskTitle('PiPlus (2 条待回答)')).toBe('PiPlus (2 条待回答)');
  });

  test('前缀反复叠加不会累积', () => {
    let title = 'PiPlus';
    for (const count of [1, 2, 3, 0]) {
      title = withAskTitle(stripAskTitle(title), count);
    }
    expect(title).toBe('PiPlus');
  });
});

describe('isWindowFocused', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  afterAll(() => {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else globalThis.window = originalWindow;
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else globalThis.document = originalDocument;
  });

  test('document 隐藏 → 失焦', () => {
    (globalThis as { window?: unknown }).window = { hasFocus: () => true };
    (globalThis as { document?: unknown }).document = { visibilityState: 'hidden', hasFocus: () => true };
    expect(isWindowFocused()).toBe(false);
  });

  test('document 可见但 hasFocus() 为 false → 失焦', () => {
    (globalThis as { window?: unknown }).window = { hasFocus: () => true };
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible', hasFocus: () => false };
    expect(isWindowFocused()).toBe(false);
  });

  test('可见且 hasFocus() 为 true → 聚焦', () => {
    (globalThis as { window?: unknown }).window = { hasFocus: () => false };
    (globalThis as { document?: unknown }).document = { visibilityState: 'visible', hasFocus: () => true };
    expect(isWindowFocused()).toBe(true);
  });
});
