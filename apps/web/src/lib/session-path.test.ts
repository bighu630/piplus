import { describe, expect, test } from 'bun:test';
import { WORKSPACE_ROOT_PATH, getSessionIdFromPath, getSessionPath } from './session-path';

describe('getSessionPath', () => {
  test('builds a session path', () => {
    expect(getSessionPath('abc')).toBe('/workspace/session/abc');
  });

  test('falls back to the workspace root without a session', () => {
    expect(getSessionPath(null)).toBe(WORKSPACE_ROOT_PATH);
  });
});

describe('getSessionIdFromPath', () => {
  test('extracts the session id', () => {
    expect(getSessionIdFromPath('/workspace/session/abc')).toBe('abc');
  });

  test('returns null for non-session paths', () => {
    expect(getSessionIdFromPath('/workspace')).toBeNull();
    expect(getSessionIdFromPath('/workspace/session/abc/extra')).toBeNull();
    expect(getSessionIdFromPath('/')).toBeNull();
  });

  test('round-trips with getSessionPath', () => {
    expect(getSessionIdFromPath(getSessionPath('xyz'))).toBe('xyz');
  });
});
