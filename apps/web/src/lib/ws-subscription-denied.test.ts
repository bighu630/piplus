import { describe, expect, test } from 'bun:test';
import {
  SUBSCRIPTION_DENIED_MAX_RETRIES,
  SUBSCRIPTION_DENIED_RETRY_DELAY_MS,
  decideSubscriptionDenied,
  subscriptionDeniedNotice,
} from './ws-subscription-denied';

describe('decideSubscriptionDenied', () => {
  test('首次被拒：安排一次延迟重订阅并向用户提示', () => {
    const decision = decideSubscriptionDenied(0);
    expect(decision).toEqual({ attempt: 1, outcome: 'retry', retry: true, notify: true });
    expect(SUBSCRIPTION_DENIED_RETRY_DELAY_MS).toBeGreaterThan(0);
  });

  test('重试期间被拒：继续重试但不重复提示（避免刷屏）', () => {
    const decision = decideSubscriptionDenied(1);
    expect(decision).toEqual({ attempt: 2, outcome: 'retry', retry: true, notify: false });
  });

  test(`超过 ${SUBSCRIPTION_DENIED_MAX_RETRIES} 次后放弃：不再重试并做最终提示`, () => {
    const decision = decideSubscriptionDenied(SUBSCRIPTION_DENIED_MAX_RETRIES);
    expect(decision).toEqual({ attempt: SUBSCRIPTION_DENIED_MAX_RETRIES + 1, outcome: 'give-up', retry: false, notify: true });
  });

  test('放弃之后再被拒：不重试也不再提示（避免无限重试循环）', () => {
    const decision = decideSubscriptionDenied(SUBSCRIPTION_DENIED_MAX_RETRIES + 1);
    expect(decision).toEqual({ attempt: SUBSCRIPTION_DENIED_MAX_RETRIES + 2, outcome: 'give-up', retry: false, notify: false });
  });

  test('异常入参（负数）按首次处理', () => {
    expect(decideSubscriptionDenied(-5).attempt).toBe(1);
  });
});

describe('subscriptionDeniedNotice', () => {
  test('重试中与放弃时的提示文案不同，且都面向用户可读', () => {
    const retry = subscriptionDeniedNotice('retry');
    const giveUp = subscriptionDeniedNotice('give-up');
    expect(retry.title).toContain('订阅');
    expect(retry.body).toContain('重试');
    expect(giveUp.title).toContain('订阅');
    expect(giveUp.body).toContain('刷新页面');
    expect(giveUp.body).not.toBe(retry.body);
  });
});
