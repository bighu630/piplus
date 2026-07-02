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
} from '@piplus/pi-client';

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
    try {
      const packages = listPiPackages();
      return c.json({ packages });
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
    const body = await c.req.json().catch(() => ({})) as { source?: string };
    const source = body.source ? body.source.trim() : undefined;

    try {
      await updatePiPackage(source);
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
    try {
      const updates = await checkPiPackageUpdates();
      return c.json({ updates });
    } catch (error) {
      return c.json(
        { error: { code: 'CHECK_FAILED', message: error instanceof Error ? error.message : 'Failed to check updates' } },
        500,
      );
    }
  });
}
