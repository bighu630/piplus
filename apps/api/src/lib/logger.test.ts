import { describe, expect, test } from 'bun:test';
import { createLogger } from './logger';

describe('logger', () => {
  test('creates logger with name', () => {
    const log = createLogger('test');
    expect(log.info).toBeFunction();
    expect(log.debug).toBeFunction();
    expect(log.warn).toBeFunction();
    expect(log.error).toBeFunction();
  });

  test('info logs without throwing', () => {
    const log = createLogger('test');
    expect(() => log.info('hello')).not.toThrow();
  });

  test('error logs without throwing', () => {
    const log = createLogger('test');
    expect(() => log.error('something broke', { code: 500 })).not.toThrow();
  });

  test('child logger inherits name', () => {
    const log = createLogger('parent');
    const child = log.child({ module: 'auth' });
    expect(child.info).toBeFunction();
    expect(() => child.info('child msg')).not.toThrow();
  });

  test('child logger merges context', () => {
    const log = createLogger('svc');
    const child = log.child({ sessionId: 's1' });
    const grand = child.child({ step: 'init' });
    expect(grand.info).toBeFunction();
    expect(() => grand.info('nested context')).not.toThrow();
  });

  test('warn and debug do not throw', () => {
    const log = createLogger('test');
    expect(() => log.warn('watch out')).not.toThrow();
    expect(() => log.debug('details')).not.toThrow();
  });
});
