import {
  type PackageSource,
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
} from '@earendil-works/pi-coding-agent';

// SDK exports DefaultPackageManager but not ConfiguredPackage/PackageUpdate
// as public types. Define local interfaces matching the SDK's shape.
interface ConfiguredPackage {
  source: string;
  scope: 'user' | 'project';
  filtered: boolean;
  installedPath?: string;
}

export interface PackageUpdate {
  source: string;
  displayName: string;
  type: 'npm' | 'git';
  scope: 'user' | 'project';
}

export type PiPackageScope = 'user' | 'project';
export type PiPackageListItem = {
  source: string;
  scope: PiPackageScope;
  filtered: boolean;
  installedPath?: string;
};

function createManager(cwd?: string) {
  const agentDir = getAgentDir();
  const resolvedCwd = cwd ?? process.cwd();
  const settingsManager = SettingsManager.create(resolvedCwd, agentDir);
  return new DefaultPackageManager({ cwd: resolvedCwd, agentDir, settingsManager });
}

/** List all configured Pi packages. */
export function listPiPackages(cwd?: string): PiPackageListItem[] {
  const pm = createManager(cwd);
  return pm.listConfiguredPackages().map((p: ConfiguredPackage) => ({
    source: p.source,
    scope: p.scope as PiPackageScope,
    filtered: p.filtered,
    installedPath: p.installedPath,
  }));
}

/** Install a Pi package and persist to settings. */
export async function installPiPackage(
  source: string,
  options?: { local?: boolean; cwd?: string },
): Promise<void> {
  const pm = createManager(options?.cwd);
  await pm.installAndPersist(source, { local: options?.local });
}

/** Remove a Pi package and persist to settings. Returns true if actually removed. */
export async function removePiPackage(
  source: string,
  options?: { local?: boolean; cwd?: string },
): Promise<boolean> {
  const pm = createManager(options?.cwd);
  return pm.removeAndPersist(source, { local: options?.local });
}

/** Update all Pi packages, or a specific one. */
export async function updatePiPackage(
  source?: string,
  options?: { cwd?: string },
): Promise<void> {
  const pm = createManager(options?.cwd);
  await pm.update(source);
}

/** Check for available updates for configured packages. */
export async function checkPiPackageUpdates(
  options?: { cwd?: string },
): Promise<PackageUpdate[]> {
  const pm = createManager(options?.cwd);
  return pm.checkForAvailableUpdates() as Promise<PackageUpdate[]>;
}

/** Enable or disable a configured package by toggling the settings format.
 *  When filtered=true, the package source is stored as an object with empty
 *  resource arrays, causing the runtime to skip loading it.
 *  When filtered=false, the package source is stored as a plain string.
 *  Returns true if the package was actually modified. */
export function setPackageFiltered(
  source: string,
  filtered: boolean,
  options?: { local?: boolean; cwd?: string },
): boolean {
  const agentDir = getAgentDir();
  const resolvedCwd = options?.cwd ?? process.cwd();
  const settingsManager = SettingsManager.create(resolvedCwd, agentDir);

  // Get current packages from the appropriate scope (defensive copy)
  const isProject = Boolean(options?.local);
  const scopeSettings = isProject
    ? settingsManager.getProjectSettings()
    : settingsManager.getGlobalSettings();
  const rawPackages = scopeSettings.packages ?? [];
  const packages: PackageSource[] = [...rawPackages];

  console.log('[setPackageFiltered] source=%s filtered=%s local=%s packagesCount=%d', source, filtered, isProject, packages.length);
  for (let i = 0; i < packages.length; i++) {
    const p = packages[i];
    const pkgSource = typeof p === 'string' ? p : p.source;
    console.log('[setPackageFiltered]   packages[%d] type=%s source=%s', i, typeof p, pkgSource);
  }

  // Find the matching package by comparing the exact source string
  const index = packages.findIndex((p) => {
    const pkgSource = typeof p === 'string' ? p : p.source;
    return pkgSource === source;
  });

  console.log('[setPackageFiltered] matchIndex=%d', index);

  if (index === -1) return false;

  const current = packages[index];

  if (filtered) {
    // Disable: convert string to object form with empty resource arrays
    if (typeof current !== 'string') return false; // already filtered
    packages[index] = { source, extensions: [], skills: [], prompts: [], themes: [] };
  } else {
    // Enable: convert object form back to plain string
    if (typeof current === 'string') return false; // already enabled
    packages[index] = source;
  }

  // Persist
  if (options?.local) {
    settingsManager.setProjectPackages(packages);
  } else {
    settingsManager.setPackages(packages);
  }

  return true;
}
