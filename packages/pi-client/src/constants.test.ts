import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveCloseRuntimeRetryIntervalMs, resolveForcedReclaimNoProgressMs } from './constants';

const RETRY_ENV = 'PIPLUS_CLOSE_RUNTIME_RETRY_MS';
const NO_PROGRESS_ENV = 'PIPLUS_FORCED_RECLAIM_NO_PROGRESS_MS';

describe('closeRuntime 回收阈值解析（调用时读取 env，便于测试动态覆盖）', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of [RETRY_ENV, NO_PROGRESS_ENV]) saved.set(key, process.env[key]);
    delete process.env[RETRY_ENV];
    delete process.env[NO_PROGRESS_ENV];
  });
  afterEach(() => {
    for (const key of [RETRY_ENV, NO_PROGRESS_ENV]) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('默认值：重试间隔 30s', () => {
    expect(resolveCloseRuntimeRetryIntervalMs()).toBe(30_000);
  });

  test('默认值：强杀无进展阈值 30 分钟', () => {
    expect(resolveForcedReclaimNoProgressMs()).toBe(1_800_000);
  });

  test('env 覆盖在调用时生效（模块加载后设置也能读到）', () => {
    process.env[RETRY_ENV] = '1234';
    process.env[NO_PROGRESS_ENV] = '5678';
    expect(resolveCloseRuntimeRetryIntervalMs()).toBe(1234);
    expect(resolveForcedReclaimNoProgressMs()).toBe(5678);
  });

  test('env 前后空白被 trim', () => {
    process.env[RETRY_ENV] = ' 250 ';
    expect(resolveCloseRuntimeRetryIntervalMs()).toBe(250);
  });

  test('非法 / 非正数 / 空值回落到默认', () => {
    for (const invalid of ['abc', '0', '-1', '', '   ']) {
      process.env[RETRY_ENV] = invalid;
      process.env[NO_PROGRESS_ENV] = invalid;
      expect(resolveCloseRuntimeRetryIntervalMs()).toBe(30_000);
      expect(resolveForcedReclaimNoProgressMs()).toBe(1_800_000);
    }
  });
});
