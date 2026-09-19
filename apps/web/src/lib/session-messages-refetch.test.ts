import { describe, expect, test } from 'bun:test';
import {
  RUNNING_MESSAGES_FALLBACK_REFETCH_MS,
  computeSessionMessagesRefetchInterval,
} from './session-messages-refetch';

describe('computeSessionMessagesRefetchInterval', () => {
  test('running 且 WS 已连接：不轮询（不再产生 1.5s interval）', () => {
    const interval = computeSessionMessagesRefetchInterval('running', true);
    expect(interval).toBe(false);
    expect(interval).not.toBe(1500);
  });

  test('running 且 WS 断开：5000ms 兜底', () => {
    expect(computeSessionMessagesRefetchInterval('running', false)).toBe(
      RUNNING_MESSAGES_FALLBACK_REFETCH_MS,
    );
  });

  test('非 running：不轮询（无论 WS 是否连接）', () => {
    expect(computeSessionMessagesRefetchInterval('idle', true)).toBe(false);
    expect(computeSessionMessagesRefetchInterval('idle', false)).toBe(false);
    expect(computeSessionMessagesRefetchInterval('stopping', true)).toBe(false);
    expect(computeSessionMessagesRefetchInterval('stopping', false)).toBe(false);
  });
});
