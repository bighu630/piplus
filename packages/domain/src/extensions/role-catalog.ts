import { isNull } from 'drizzle-orm';
import { roleTemplates } from '@piplus/db/schema';
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
    description: 'Reviews output and returns critiques or confirmations.',
    source: 'builtin',
  },
  {
    key: 'researcher',
    name: 'Researcher',
    description: 'Investigates a topic and summarizes findings.',
    source: 'builtin',
  },
];

export async function loadRoleCatalog(db: RoleManagerDb): Promise<RoleCatalog> {
  const dbRows: Array<{ key: string; name: string; description: string }> = await db
    .select({
      key: roleTemplates.key,
      name: roleTemplates.name,
      description: roleTemplates.description,
    })
    .from(roleTemplates)
    .where(isNull(roleTemplates.archivedAt));

  const dbMap = new Map<string, { name: string; description: string }>();
  for (const row of dbRows) {
    dbMap.set(row.key, { name: row.name, description: row.description });
  }

  const roles: RoleCatalogEntry[] = [];
  for (const builtin of BUILTIN_ROLES) {
    const dbOverride = dbMap.get(builtin.key);
    if (dbOverride?.description?.trim()) {
      roles.push({
        key: builtin.key,
        name: dbOverride.name || builtin.name,
        description: dbOverride.description,
        source: 'db',
      });
      dbMap.delete(builtin.key);
    } else {
      roles.push(builtin);
    }
  }

  for (const [key, value] of dbMap) {
    roles.push({
      key,
      name: value.name,
      description: value.description?.trim()
        ? value.description
        : `${value.name} session.`,
      source: 'db',
    });
  }

  return { roles };
}
