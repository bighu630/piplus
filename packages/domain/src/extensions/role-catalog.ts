import { and, desc, eq, isNull } from 'drizzle-orm';
import { projects, roleTemplates } from '@piplus/db/schema';
import type { RoleManagerDb } from '../role-manager/service';

export type RoleCatalogEntry = {
  key: string;
  name: string;
  description: string;
  source: 'builtin' | 'db';
};

export type RoleCatalog = {
  roles: RoleCatalogEntry[];
};

const BUILTIN_ROLE_KEYS = ['planner', 'worker', 'reviewer', 'feature_lead', 'bugfix_lead'] as const;
const BUILTIN_ROLES: RoleCatalogEntry[] = [
  {
    key: 'planner',
    name: 'Planner',
    description: 'Plans and coordinates work. Breaks large goals into structured steps.',
    source: 'builtin',
  },
  {
    key: 'worker',
    name: 'Worker',
    description: 'Executes concrete implementation tasks.',
    source: 'builtin',
  },
  {
    key: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews code quality and provides specific, actionable feedback to the user.',
    source: 'builtin',
  },
  {
    key: 'feature_lead',
    name: 'Feature Lead',
    description: 'Aligns with user on feature requirements, plans the approach, and delegates execution to workers.',
    source: 'builtin',
  },
  {
    key: 'bugfix_lead',
    name: 'Bugfix Lead',
    description: 'Aligns with user on bug details, diagnoses root cause, and delegates fixes to workers.',
    source: 'builtin',
  },
];

const BUILTIN_KEY_SET = new Set<string>(BUILTIN_ROLE_KEYS);

async function loadVersionForRole(db: RoleManagerDb, key: string, version?: string): Promise<{ name: string; description: string } | null> {
  if (version) {
    const [row] = await db
      .select({ name: roleTemplates.name, description: roleTemplates.description })
      .from(roleTemplates)
      .where(and(eq(roleTemplates.key, key), eq(roleTemplates.version, version), isNull(roleTemplates.archivedAt)))
      .limit(1);
    if (row) return row;
  }
  // No version specified or version not found: prefer built-in, then latest
  const [builtin] = await db
    .select({ name: roleTemplates.name, description: roleTemplates.description })
    .from(roleTemplates)
    .where(and(eq(roleTemplates.key, key), eq(roleTemplates.isBuiltin, true), isNull(roleTemplates.archivedAt)))
    .orderBy(desc(roleTemplates.version))
    .limit(1);
  if (builtin) return builtin;
  // No built-in version found: fall back to latest any version
  const [row] = await db
    .select({ name: roleTemplates.name, description: roleTemplates.description })
    .from(roleTemplates)
    .where(and(eq(roleTemplates.key, key), isNull(roleTemplates.archivedAt)))
    .orderBy(desc(roleTemplates.version))
    .limit(1);
  return row ?? null;
}

export async function loadRoleCatalog(db: RoleManagerDb, projectId?: string): Promise<RoleCatalog> {
  // Load project role config if projectId is given
  let roleConfig: Record<string, { enabled?: boolean; version?: string }> = {};
  if (projectId) {
    const [project] = await db
      .select({ roleConfigJson: projects.roleConfigJson })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (project?.roleConfigJson) {
      try {
        roleConfig = JSON.parse(project.roleConfigJson);
      } catch {}
    }
  }

  const roles: RoleCatalogEntry[] = [];

  // Process built-in roles first, preserving their order
  for (const builtin of BUILTIN_ROLES) {
    const cfg = roleConfig[builtin.key];
    // Skip disabled roles
    if (cfg?.enabled === false) continue;

    const version = cfg?.version;
    const dbInfo = await loadVersionForRole(db, builtin.key, version);

    roles.push({
      key: builtin.key,
      name: dbInfo?.name ?? builtin.name,
      description: dbInfo?.description ?? builtin.description,
      source: dbInfo ? 'db' : 'builtin',
    });
    // Remove from roleConfig so we don't process again
    delete roleConfig[builtin.key];
  }

  // Process any remaining (custom) roles from roleConfig
  for (const [key, cfg] of Object.entries(roleConfig)) {
    if (cfg?.enabled === false) continue;
    const version = cfg?.version;
    const dbInfo = await loadVersionForRole(db, key, version);
    if (dbInfo) {
      roles.push({
        key,
        name: dbInfo.name,
        description: dbInfo.description,
        source: 'db',
      });
    }
  }

  // Also load any custom roles from DB that are NOT in roleConfig
  const dbRows = await db
    .select({ key: roleTemplates.key, name: roleTemplates.name, description: roleTemplates.description })
    .from(roleTemplates)
    .where(isNull(roleTemplates.archivedAt))
    .orderBy(desc(roleTemplates.version));

  const processedKeys = new Set(roles.map(r => r.key));
  for (const row of dbRows) {
    if (!processedKeys.has(row.key)) {
      const cfg = roleConfig[row.key];
      if (cfg?.enabled === false) continue;
      roles.push({
        key: row.key,
        name: row.name,
        description: row.description,
        source: 'db',
      });
      processedKeys.add(row.key);
    }
  }

  return { roles };
}
