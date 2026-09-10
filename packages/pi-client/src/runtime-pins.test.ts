import { beforeEach, describe, expect, test } from 'bun:test';
import {
  isSessionRuntimePinned,
  pinSessionRuntime,
  resetSessionRuntimePins,
  unpinSessionRuntime,
} from './runtime-pins';

describe('runtime-pins（平台长等待 pin 豁免）', () => {
  beforeEach(() => {
    resetSessionRuntimePins();
  });

  test('未 pin 的会话 isSessionRuntimePinned 为 false', () => {
    expect(isSessionRuntimePinned('sess_never_pinned')).toBe(false);
  });

  test('pin 一次后为 pinned', () => {
    pinSessionRuntime('sess_pin_once');
    expect(isSessionRuntimePinned('sess_pin_once')).toBe(true);
  });

  test('refcount 语义：连续 pin 两次 + unpin 一次仍 pinned', () => {
    pinSessionRuntime('sess_pin_twice');
    pinSessionRuntime('sess_pin_twice');
    unpinSessionRuntime('sess_pin_twice');
    expect(isSessionRuntimePinned('sess_pin_twice')).toBe(true);

    // 第二次 unpin 才真正解除
    unpinSessionRuntime('sess_pin_twice');
    expect(isSessionRuntimePinned('sess_pin_twice')).toBe(false);
  });

  test('未 pin 时 unpin 是 no-op（floor 0，不产生负计数）', () => {
    unpinSessionRuntime('sess_unpin_noop');
    unpinSessionRuntime('sess_unpin_noop');
    expect(isSessionRuntimePinned('sess_unpin_noop')).toBe(false);

    // 之后 pin 一次仍正常生效（计数未被负数污染）
    pinSessionRuntime('sess_unpin_noop');
    expect(isSessionRuntimePinned('sess_unpin_noop')).toBe(true);
  });

  test('resetSessionRuntimePins 清空全部 pin 状态', () => {
    pinSessionRuntime('sess_reset_a');
    pinSessionRuntime('sess_reset_b');
    resetSessionRuntimePins();
    expect(isSessionRuntimePinned('sess_reset_a')).toBe(false);
    expect(isSessionRuntimePinned('sess_reset_b')).toBe(false);
  });
});
