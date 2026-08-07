const FILES_EXPANDED_STORAGE_KEY = 'pi-files-expanded-v1';
const FILES_SELECTED_STORAGE_KEY = 'pi-files-selected-v1';
const MAX_PROJECTS_PER_VIEW = 50;

export { FILES_EXPANDED_STORAGE_KEY, FILES_SELECTED_STORAGE_KEY, MAX_PROJECTS_PER_VIEW };

export type FilesViewKey = 'files' | 'doce';

interface FilesEntry<T> {
  state: T;
  updatedAt: number;
}

type FilesViewMap<T> = Record<string, FilesEntry<T>>;

type FilesStore<T> = Partial<Record<FilesViewKey, FilesViewMap<T>>>;

function readStore<T>(key: string): FilesStore<T> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as FilesStore<T>;
  } catch {
    return {};
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read the per-view map from a parsed store. A corrupted view value (string,
 * number, array, …) is treated as an empty map instead of being passed
 * through, so writes never throw on it and reads never return garbage.
 */
function readViewMap<T>(store: FilesStore<T>, view: FilesViewKey): FilesViewMap<T> {
  return isPlainObject(store[view]) ? (store[view] as FilesViewMap<T>) : {};
}

function writeStore<T>(key: string, store: FilesStore<T>): void {
  try {
    localStorage.setItem(key, JSON.stringify(store));
  } catch {
    // localStorage full or unavailable — silently ignore
  }
}

/**
 * If a view holds more than MAX_PROJECTS_PER_VIEW entries, drop the
 * ones with the oldest updatedAt until the limit is satisfied.
 */
function pruneOldestProjects<T>(viewMap: FilesViewMap<T>): FilesViewMap<T> {
  let projectIds = Object.keys(viewMap);
  while (projectIds.length > MAX_PROJECTS_PER_VIEW) {
    let oldestId: string | null = null;
    let oldestUpdatedAt = Infinity;
    for (const projectId of projectIds) {
      const record = viewMap[projectId];
      if (record && record.updatedAt < oldestUpdatedAt) {
        oldestUpdatedAt = record.updatedAt;
        oldestId = projectId;
      }
    }
    if (oldestId === null) break;
    delete viewMap[oldestId];
    projectIds = Object.keys(viewMap);
  }
  return viewMap;
}

/**
 * Load the persisted expanded-path state for the given view + project.
 * Returns {} when nothing is stored (identical to the default state).
 */
export function loadExpandedPaths(view: FilesViewKey, projectId: string): Record<string, boolean> {
  if (!projectId) return {};
  const store = readStore<Record<string, boolean>>(FILES_EXPANDED_STORAGE_KEY);
  const viewMap = readViewMap(store, view);
  const entry = viewMap[projectId];
  if (!entry || typeof entry.state !== 'object' || entry.state === null || Array.isArray(entry.state)) {
    return {};
  }
  return entry.state;
}

/**
 * Save a single entry for the given view + project. `entry === null` removes the entry.
 * Shared by both save functions so the corrupted-view-map guard and the
 * "no trace for empty state" behavior stay in one place.
 */
function saveEntry<T>(key: string, view: FilesViewKey, projectId: string, entry: FilesEntry<T> | null): void {
  if (!projectId) return;
  const store = readStore<T>(key);
  const viewMap = readViewMap(store, view);
  const hadEntries = Object.keys(viewMap).length > 0;
  if (entry) {
    viewMap[projectId] = entry;
  } else {
    delete viewMap[projectId];
  }
  // Nothing to persist: the view map is (still) empty and the view didn't
  // previously hold entries that this operation removed. Leave no trace.
  if (Object.keys(viewMap).length === 0 && !hadEntries) return;
  store[view] = pruneOldestProjects(viewMap);
  writeStore(key, store);
}

/**
 * Save the expanded-path state for the given view + project.
 * An empty state removes the entry (same as never having expanded anything).
 */
export function saveExpandedPaths(view: FilesViewKey, projectId: string, paths: Record<string, boolean>): void {
  const entry =
    paths && Object.keys(paths).length > 0 ? { state: paths, updatedAt: Date.now() } : null;
  saveEntry(FILES_EXPANDED_STORAGE_KEY, view, projectId, entry);
}

/**
 * Load the persisted selected-path state for the given view + project.
 * Returns null when nothing is stored.
 */
export function loadSelectedPath(view: FilesViewKey, projectId: string): string | null {
  if (!projectId) return null;
  const store = readStore<string | null>(FILES_SELECTED_STORAGE_KEY);
  const viewMap = readViewMap(store, view);
  const entry = viewMap[projectId];
  if (!entry || typeof entry.state !== 'string') return null;
  return entry.state;
}

/**
 * Save the selected-path state for the given view + project.
 * A null path removes the entry.
 */
export function saveSelectedPath(view: FilesViewKey, projectId: string, path: string | null): void {
  const entry = path ? { state: path, updatedAt: Date.now() } : null;
  saveEntry(FILES_SELECTED_STORAGE_KEY, view, projectId, entry);
}
