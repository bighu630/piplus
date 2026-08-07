import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  FILES_EXPANDED_STORAGE_KEY,
  FILES_SELECTED_STORAGE_KEY,
  MAX_PROJECTS_PER_VIEW,
  loadExpandedPaths,
  loadSelectedPath,
  saveExpandedPaths,
  saveSelectedPath,
} from './files-persistence';

// bun test has no DOM, so localStorage is undefined — provide an in-memory mock.
function mockLocalStorage(): Map<string, string> {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key: string) => (data.has(key) ? data.get(key)! : null),
    key: (index: number) => Array.from(data.keys())[index] ?? null,
    removeItem: (key: string) => void data.delete(key),
    setItem: (key: string, value: string) => void data.set(key, value),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    configurable: true,
    writable: true,
  });
  return data;
}

describe('files-persistence', () => {
  let data: Map<string, string>;

  beforeEach(() => {
    data = mockLocalStorage();
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: undefined,
      configurable: true,
      writable: true,
    });
  });

  test('expanded paths roundtrip', () => {
    saveExpandedPaths('files', 'p1', { 'src': true, 'src/a.ts': false });
    expect(loadExpandedPaths('files', 'p1')).toEqual({ 'src': true, 'src/a.ts': false });
  });

  test('selected path roundtrip', () => {
    saveSelectedPath('doce', 'p1', 'docs/guide.md');
    expect(loadSelectedPath('doce', 'p1')).toBe('docs/guide.md');
  });

  test('returns defaults when nothing is stored', () => {
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
    expect(loadSelectedPath('files', 'p1')).toBeNull();
  });

  test('views are isolated from each other', () => {
    saveExpandedPaths('files', 'p1', { 'src': true });
    saveSelectedPath('files', 'p1', 'src/a.ts');
    saveExpandedPaths('doce', 'p1', { 'docs': false });
    saveSelectedPath('doce', 'p1', 'docs/guide.md');

    expect(loadExpandedPaths('files', 'p1')).toEqual({ 'src': true });
    expect(loadSelectedPath('files', 'p1')).toBe('src/a.ts');
    expect(loadExpandedPaths('doce', 'p1')).toEqual({ 'docs': false });
    expect(loadSelectedPath('doce', 'p1')).toBe('docs/guide.md');
  });

  test('projects are isolated from each other', () => {
    saveExpandedPaths('files', 'p1', { 'src': true });
    saveSelectedPath('files', 'p1', 'src/a.ts');
    saveExpandedPaths('files', 'p2', { 'lib': true });
    saveSelectedPath('files', 'p2', 'lib/b.ts');

    expect(loadExpandedPaths('files', 'p1')).toEqual({ 'src': true });
    expect(loadSelectedPath('files', 'p1')).toBe('src/a.ts');
    expect(loadExpandedPaths('files', 'p2')).toEqual({ 'lib': true });
    expect(loadSelectedPath('files', 'p2')).toBe('lib/b.ts');
  });

  test('empty or null projectId never touches localStorage', () => {
    saveExpandedPaths('files', '', { 'src': true });
    saveSelectedPath('files', '', 'src/a.ts');
    expect(data.size).toBe(0);
    expect(loadExpandedPaths('files', '')).toEqual({});
    expect(loadSelectedPath('files', '')).toBeNull();
  });

  test('saving empty expanded state removes the entry', () => {
    saveExpandedPaths('files', 'p1', { 'src': true });
    saveExpandedPaths('files', 'p1', {});
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
    const store = JSON.parse(data.get(FILES_EXPANDED_STORAGE_KEY)!);
    expect(store.files.p1).toBeUndefined();
  });

  test('saving null selected path removes the entry', () => {
    saveSelectedPath('files', 'p1', 'src/a.ts');
    saveSelectedPath('files', 'p1', null);
    expect(loadSelectedPath('files', 'p1')).toBeNull();
    const store = JSON.parse(data.get(FILES_SELECTED_STORAGE_KEY)!);
    expect(store.files.p1).toBeUndefined();
  });

  test('corrupted localStorage data falls back to defaults', () => {
    data.set(FILES_EXPANDED_STORAGE_KEY, '{not valid json');
    data.set(FILES_SELECTED_STORAGE_KEY, '42');
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
    expect(loadSelectedPath('files', 'p1')).toBeNull();
  });

  test('non-object expanded state falls back to defaults', () => {
    data.set(FILES_EXPANDED_STORAGE_KEY, JSON.stringify({ files: { p1: { state: 'oops', updatedAt: 1 } } }));
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
  });

  test('non-string selected state falls back to null', () => {
    data.set(FILES_SELECTED_STORAGE_KEY, JSON.stringify({ files: { p1: { state: 42, updatedAt: 1 } } }));
    expect(loadSelectedPath('files', 'p1')).toBeNull();
  });

  test('array expanded state falls back to defaults', () => {
    data.set(FILES_EXPANDED_STORAGE_KEY, JSON.stringify({ files: { p1: { state: ['a', 'b'], updatedAt: 1 } } }));
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
  });

  test('string view map falls back to defaults', () => {
    data.set(FILES_EXPANDED_STORAGE_KEY, JSON.stringify({ files: 'corrupted' }));
    data.set(FILES_SELECTED_STORAGE_KEY, JSON.stringify({ files: 'corrupted' }));
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
    expect(loadSelectedPath('files', 'p1')).toBeNull();
    // other views are unaffected
    expect(loadExpandedPaths('doce', 'p1')).toEqual({});
    expect(loadSelectedPath('doce', 'p1')).toBeNull();
  });

  test('array view map falls back to defaults', () => {
    data.set(FILES_EXPANDED_STORAGE_KEY, JSON.stringify({ files: [1, 2] }));
    data.set(FILES_SELECTED_STORAGE_KEY, JSON.stringify({ files: [1, 2] }));
    expect(loadExpandedPaths('files', 'p1')).toEqual({});
    expect(loadSelectedPath('files', 'p1')).toBeNull();
  });

  test('save recovers from a corrupted view map without throwing', () => {
    data.set(FILES_EXPANDED_STORAGE_KEY, JSON.stringify({ files: 'corrupted' }));
    data.set(FILES_SELECTED_STORAGE_KEY, JSON.stringify({ files: [1, 2] }));
    expect(() => saveExpandedPaths('files', 'p1', { 'src': true })).not.toThrow();
    expect(() => saveSelectedPath('files', 'p1', 'src/a.ts')).not.toThrow();
    // the new values must be readable back
    expect(loadExpandedPaths('files', 'p1')).toEqual({ 'src': true });
    expect(loadSelectedPath('files', 'p1')).toBe('src/a.ts');
  });

  test('saving empty state when nothing is stored leaves no trace', () => {
    saveExpandedPaths('files', 'p1', {});
    saveSelectedPath('files', 'p1', null);
    expect(data.size).toBe(0);
  });

  test('prunes the oldest project entries when a view exceeds the limit', () => {
    // Fill a view with MAX_PROJECTS_PER_VIEW projects, oldest first
    for (let i = 0; i < MAX_PROJECTS_PER_VIEW; i++) {
      saveExpandedPaths('files', `old-${i}`, { [`file-${i}`]: true });
    }
    // Saving one more must evict the oldest entry
    saveExpandedPaths('files', 'newest', { 'file-new': true });

    const store = JSON.parse(data.get(FILES_EXPANDED_STORAGE_KEY)!);
    expect(Object.keys(store.files)).toHaveLength(MAX_PROJECTS_PER_VIEW);
    expect(store.files['old-0']).toBeUndefined();
    expect(store.files['newest']).toBeDefined();
    // The other view is untouched
    expect(store.doce).toBeUndefined();
  });

  test('pruning is scoped per view', () => {
    for (let i = 0; i < MAX_PROJECTS_PER_VIEW + 5; i++) {
      saveSelectedPath('files', `p-${i}`, `file-${i}.ts`);
    }
    saveSelectedPath('doce', 'only-docs', 'docs/guide.md');
    const store = JSON.parse(data.get(FILES_SELECTED_STORAGE_KEY)!);
    expect(Object.keys(store.files)).toHaveLength(MAX_PROJECTS_PER_VIEW);
    expect(store.doce).toEqual({ 'only-docs': { state: 'docs/guide.md', updatedAt: expect.any(Number) } });
  });
});
