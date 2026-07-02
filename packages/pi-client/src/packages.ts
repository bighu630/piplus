import {
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
