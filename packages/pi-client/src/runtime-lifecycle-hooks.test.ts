import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  clearForcedRuntimeDisposeHandlers,
  notifyForcedRuntimeDispose,
  registerForcedRuntimeDisposeHandler,
  type ForcedRuntimeDisposeInfo,
} from './runtime-lifecycle-hooks';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const info = (sessionId: string): ForcedRuntimeDisposeInfo => ({
  sessionId,
  disposedAt: Date.now(),
  attempts: 7,
  noProgressMs: 1234,
});

describe('runtime-lifecycle-hooks（强制回收通知）', () => {
  beforeEach(() => {
    clearForcedRuntimeDisposeHandlers();
  });
  afterEach(() => {
    clearForcedRuntimeDisposeHandlers();
  });

  test('notify 向所有已注册 handler 串行传递 info', async () => {
    const received: ForcedRuntimeDisposeInfo[] = [];
    registerForcedRuntimeDisposeHandler((value) => {
      received.push(value);
    });
    registerForcedRuntimeDisposeHandler(async (value) => {
      received.push(value);
    });

    await notifyForcedRuntimeDispose(info('sess_notify_all'));

    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ sessionId: 'sess_notify_all', attempts: 7, noProgressMs: 1234 });
    expect(received[1]).toMatchObject({ sessionId: 'sess_notify_all' });
  });

  test('handler 串行执行：前一个 await 完成后才调用下一个', async () => {
    const order: string[] = [];
    registerForcedRuntimeDisposeHandler(async () => {
      await sleep(30);
      order.push('first');
    });
    registerForcedRuntimeDisposeHandler(() => {
      order.push('second');
    });

    await notifyForcedRuntimeDispose(info('sess_serial'));

    expect(order).toEqual(['first', 'second']);
  });

  test('单个 handler 抛错不影响其它 handler，也不向外抛', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const received: string[] = [];
    registerForcedRuntimeDisposeHandler(() => {
      throw new Error('handler boom');
    });
    registerForcedRuntimeDisposeHandler((value) => {
      received.push(value.sessionId);
    });

    let thrown: unknown;
    try {
      await notifyForcedRuntimeDispose(info('sess_hook_error'));
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeUndefined();
    expect(received).toEqual(['sess_hook_error']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test('async handler reject 同样被隔离', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const received: string[] = [];
    registerForcedRuntimeDisposeHandler(async () => {
      throw new Error('async boom');
    });
    registerForcedRuntimeDisposeHandler((value) => {
      received.push(value.sessionId);
    });

    await notifyForcedRuntimeDispose(info('sess_hook_async_error'));

    expect(received).toEqual(['sess_hook_async_error']);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  test('clearForcedRuntimeDisposeHandlers 清空后不再通知', async () => {
    const received: string[] = [];
    registerForcedRuntimeDisposeHandler((value) => {
      received.push(value.sessionId);
    });
    clearForcedRuntimeDisposeHandlers();

    await notifyForcedRuntimeDispose(info('sess_hook_cleared'));

    expect(received).toEqual([]);
  });
});
