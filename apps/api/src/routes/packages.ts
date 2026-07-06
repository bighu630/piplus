import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { projects } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { getDbPath } from '../db-context';
import {
  listPiPackages,
  installPiPackage,
  removePiPackage,
  updatePiPackage,
  checkPiPackageUpdates,
  setPackageFiltered,
  createPiClient,
} from '@piplus/pi-client';

const piClient = createPiClient();

const SOURCE_PREFIX_PATTERN = /^(npm:|git:|https:\/\/|ssh:\/\/|\.\/|\.\.\/|\/)/;

function validateSource(source: string): string | null {
  if (!source) return 'source is required';
  if (source.length > 500) return 'source must be ≤ 500 characters';
  if (!SOURCE_PREFIX_PATTERN.test(source)) {
    return 'source must start with npm:, git:, https://, ssh://, ./, ../, or /';
  }
  return null;
}

/**
 * Look up a project and verify ownership for local-scoped operations.
 * Returns the project path, or sends an error response.
 */
function resolveProject(c: any, projectId: string, userId: string): { path: string } | Response {
  const db = createDb(`file:${getDbPath()}`);
  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  if (!project) {
    return c.json({ error: { code: 'PROJECT_NOT_FOUND', message: 'Project not found' } }, 404);
  }
  if (project.createdBy !== userId) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Project does not belong to current user' } }, 403);
  }
  return { path: project.projectPath };
}

export function registerPackagesRoutes(app: Hono) {
  // GET /api/v1/packages — list configured packages
  app.get('/api/v1/packages', async (c) => {
    const projectId = c.req.query('project_id')?.trim() || undefined;

    try {
      if (projectId) {
        const userId = (c as any).get('userId') as string;
        const resolved = resolveProject(c, projectId, userId);
        if (resolved instanceof Response) return resolved;
        const packages = listPiPackages(resolved.path);
        return c.json({ packages });
      }
      const packages = listPiPackages();
      // Global view: only show user-scoped packages. Project-scoped packages
      // are managed through the project-specific endpoint with ?project_id=.
      return c.json({ packages: packages.filter((p) => p.scope !== 'project') });
    } catch (error) {
      return c.json(
        { error: { code: 'LIST_FAILED', message: error instanceof Error ? error.message : 'Failed to list packages' } },
        500,
      );
    }
  });

  // POST /api/v1/packages/install — install and persist a package
  app.post('/api/v1/packages/install', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      source?: string;
      local?: boolean;
      project_id?: string;
    };
    const source = (body.source ?? '').trim();
    const local = Boolean(body.local);
    const projectId = (body.project_id ?? '').trim();

    const validationError = validateSource(source);
    if (validationError) {
      return c.json({ error: { code: 'INVALID_SOURCE', message: validationError } }, 400);
    }

    try {
      let cwd: string | undefined;
      if (local) {
        if (!projectId) {
          return c.json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'project_id is required when local=true' } }, 400);
        }
        const userId = (c as any).get('userId') as string;
        const resolved = resolveProject(c, projectId, userId);
        if (resolved instanceof Response) return resolved;
        cwd = resolved.path;
      }
      await installPiPackage(source, { local, cwd });
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: { code: 'INSTALL_FAILED', message: error instanceof Error ? error.message : 'Installation failed' } },
        500,
      );
    }
  });

  // POST /api/v1/packages/remove — remove and persist
  app.post('/api/v1/packages/remove', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      source?: string;
      local?: boolean;
      project_id?: string;
    };
    const source = (body.source ?? '').trim();
    const local = Boolean(body.local);
    const projectId = (body.project_id ?? '').trim();

    const validationError = validateSource(source);
    if (validationError) {
      return c.json({ error: { code: 'INVALID_SOURCE', message: validationError } }, 400);
    }

    try {
      let cwd: string | undefined;
      if (local) {
        if (!projectId) {
          return c.json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'project_id is required when local=true' } }, 400);
        }
        const userId = (c as any).get('userId') as string;
        const resolved = resolveProject(c, projectId, userId);
        if (resolved instanceof Response) return resolved;
        cwd = resolved.path;
      }
      const removed = await removePiPackage(source, { local, cwd });
      return c.json({ ok: removed });
    } catch (error) {
      return c.json(
        { error: { code: 'REMOVE_FAILED', message: error instanceof Error ? error.message : 'Removal failed' } },
        500,
      );
    }
  });

  // POST /api/v1/packages/update — update a specific or all packages
  app.post('/api/v1/packages/update', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      source?: string;
      local?: boolean;
      project_id?: string;
    };
    const source = body.source ? body.source.trim() : undefined;
    const local = Boolean(body.local);
    const projectId = (body.project_id ?? '').trim();

    try {
      let cwd: string | undefined;
      if (local) {
        if (!projectId) {
          return c.json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'project_id is required when local=true' } }, 400);
        }
        const userId = (c as any).get('userId') as string;
        const resolved = resolveProject(c, projectId, userId);
        if (resolved instanceof Response) return resolved;
        cwd = resolved.path;
      }
      await updatePiPackage(source, { cwd });
      return c.json({ ok: true });
    } catch (error) {
      return c.json(
        { error: { code: 'UPDATE_FAILED', message: error instanceof Error ? error.message : 'Update failed' } },
        500,
      );
    }
  });

  // GET /api/v1/packages/updates — check for available updates
  app.get('/api/v1/packages/updates', async (c) => {
    const projectId = c.req.query('project_id')?.trim() || undefined;

    try {
      if (projectId) {
        const userId = (c as any).get('userId') as string;
        const resolved = resolveProject(c, projectId, userId);
        if (resolved instanceof Response) return resolved;
        const updates = await checkPiPackageUpdates({ cwd: resolved.path });
        return c.json({ updates });
      }
      const updates = await checkPiPackageUpdates();
      return c.json({ updates });
    } catch (error) {
      return c.json(
        { error: { code: 'CHECK_FAILED', message: error instanceof Error ? error.message : 'Failed to check updates' } },
        500,
      );
    }
  });

  // POST /api/v1/packages/toggle — enable/disable a package (toggle filtered flag)
  app.post('/api/v1/packages/toggle', async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      source?: string;
      filtered?: boolean;
      local?: boolean;
      project_id?: string;
    };
    const source = (body.source ?? '').trim();
    const filtered = Boolean(body.filtered);
    const local = Boolean(body.local);
    const projectId = (body.project_id ?? '').trim();

    const validationError = validateSource(source);
    if (validationError) {
      return c.json({ error: { code: 'INVALID_SOURCE', message: validationError } }, 400);
    }

    try {
      let cwd: string | undefined;
      if (local) {
        if (!projectId) {
          return c.json({ error: { code: 'PROJECT_ID_REQUIRED', message: 'project_id is required when local=true' } }, 400);
        }
        const userId = (c as any).get('userId') as string;
        const resolved = resolveProject(c, projectId, userId);
        if (resolved instanceof Response) return resolved;
        cwd = resolved.path;
      }

      const ok = setPackageFiltered(source, filtered, { local, cwd });

      // Fire-and-forget: reload idle runtimes so they pick up new settings.
      // Running sessions are left untouched; they'll use new settings on next run.
      piClient.reloadIdleRuntimes().catch((err) => {
        console.error('[packages] reloadIdleRuntimes failed', err);
      });

      return c.json({ ok });
    } catch (error) {
      return c.json(
        { error: { code: 'TOGGLE_FAILED', message: error instanceof Error ? error.message : 'Failed to toggle package' } },
        500,
      );
    }
  });
}
