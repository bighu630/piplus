import { execSync } from 'node:child_process';
import path from 'node:path';
import { createDb } from '@piplus/db/client';
import { eq } from 'drizzle-orm';
import { projects, sessions } from '@piplus/db/schema';
import { getDbPath } from '../../db-context';

export function resolveProjectDir(c: any, userId: string, sessionId: string) {
  const db = createDb(`file:${getDbPath()}`);
  const [session] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
  if (!session) return { error: { code: 'NOT_FOUND', message: 'Session not found' }, status: 404 } as const;

  const [project] = db.select({ projectPath: projects.projectPath, createdBy: projects.createdBy, gitConfigJson: projects.gitConfigJson }).from(projects).where(eq(projects.id, session.projectId)).limit(1).all();
  if (!project || project.createdBy !== userId) return { error: { code: 'NOT_FOUND', message: 'Session not found' }, status: 404 } as const;

  const cwd = session.worktreePath ? path.resolve(session.worktreePath) : (project.projectPath || process.cwd());
  return { cwd, sessionWorktreePath: session.worktreePath ?? null, gitConfigJson: project.gitConfigJson ?? '{}' };
}

export function resolveSafeFilePath(rootDir: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, '/');
  const resolved = path.resolve(rootDir, normalized);
  const relative = path.relative(rootDir, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

export function execGit(cwd: string, ...args: string[]) {
  const stdout = execSync(`git ${args.join(' ')}`, { cwd, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).toString();
  return stdout;
}
