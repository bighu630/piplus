import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import {
  clampSidebarWidth,
  initialHiddenCompletedRoles,
  parseHiddenCompletedRoles,
  parseShowCompleted,
} from './app-prefs';

// App UI 偏好的持久化契约：这些 parse 决定「历史 localStorage 值如何映射回状态」，
// 拆 App 时最容易静默改坏，因此单独锁住。
describe('app-prefs persistence contract', () => {
  test('clampSidebarWidth clamps to [240, 520] and falls back to 256', () => {
    expect(clampSidebarWidth('300')).toBe(300);
    expect(clampSidebarWidth('100')).toBe(240);
    expect(clampSidebarWidth('9999')).toBe(520);
    expect(clampSidebarWidth('0')).toBe(240);
    expect(clampSidebarWidth('abc')).toBe(256);
    expect(clampSidebarWidth('')).toBe(256);
  });

  test('parseShowCompleted treats only explicit "false" as off', () => {
    expect(parseShowCompleted('false')).toBe(false);
    expect(parseShowCompleted('true')).toBe(true);
    expect(parseShowCompleted('')).toBe(true);
  });

  test('parseHiddenCompletedRoles parses JSON and falls back to an empty array', () => {
    expect(parseHiddenCompletedRoles('["worker","reviewer"]')).toEqual(['worker', 'reviewer']);
    expect(parseHiddenCompletedRoles('[]')).toEqual([]);
    expect(parseHiddenCompletedRoles('{not json')).toEqual([]);
  });

  describe('initialHiddenCompletedRoles (legacy pi-show-worker migration)', () => {
    const originalWindow = globalThis.window;
    let window: Window;

    beforeAll(() => {
      window = new Window({ url: 'https://demo.example.com/' });
      globalThis.window = window as unknown as Window & typeof globalThis;
    });

    afterAll(() => {
      globalThis.window = originalWindow;
    });

    beforeEach(() => {
      window.localStorage.clear();
    });

    test('migrates legacy pi-show-worker=false to hidden worker role', () => {
      window.localStorage.setItem('pi-show-worker', 'false');
      expect(initialHiddenCompletedRoles()).toEqual(['worker']);
    });

    test('does not migrate when legacy flag is true or absent', () => {
      window.localStorage.setItem('pi-show-worker', 'true');
      expect(initialHiddenCompletedRoles()).toEqual([]);

      window.localStorage.removeItem('pi-show-worker');
      expect(initialHiddenCompletedRoles()).toEqual([]);
    });
  });
});
