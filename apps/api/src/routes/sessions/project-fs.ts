import { existsSync } from 'node:fs';
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

  const projectDir = project.projectPath || process.cwd();
  const worktreeDir = session.worktreePath ? path.resolve(session.worktreePath) : null;

  // worktree 目录可能被外部清理（rm -rf / git worktree prune）：此时把 cwd 回落到项目根，
  // 并清除会话上的关联，否则后续所有 git / 文件操作都会在已消失的 cwd 上失败。
  // 注：Bun 的 execSync 在 cwd 不存在时报的是误导性的 `posix_spawn '/bin/sh'` ENOENT，
  // 容易被误判为“缺少 shell”，所以这里必须显式检测而不是依赖下游报错。
  if (worktreeDir && !existsSync(worktreeDir)) {
    db.update(sessions).set({ worktreePath: null, updatedAt: new Date() }).where(eq(sessions.id, sessionId)).run();
    return {
      cwd: projectDir,
      sessionWorktreePath: null,
      gitConfigJson: project.gitConfigJson ?? '{}',
      missingWorktreePath: worktreeDir,
    };
  }

  return {
    cwd: worktreeDir ?? projectDir,
    sessionWorktreePath: session.worktreePath ?? null,
    gitConfigJson: project.gitConfigJson ?? '{}',
    missingWorktreePath: null,
  };
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
  // LC_ALL=C：强制 git 输出稳定英文（如 detached HEAD 伪分支名），避免中文 locale 下解析失败
  const stdout = execSync(`git ${args.join(' ')}`, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  }).toString();
  return stdout;
}
