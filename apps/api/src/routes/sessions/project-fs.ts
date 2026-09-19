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
  // 并在每次响应里如实回报原路径，让前端可以持续提示。
  // 刻意**不在这里清库**：existsSync 对「祖先目录不可访问」（网络盘未挂载、EACCES、挂载延迟）
  // 也会返回 false，读时清空会把一个暂时不可用的有效关联永久删掉；清空交给既有显式路径
  // （git/checkout 切到普通分支时会清空，切到 worktree 分支时会写回）。
  const worktreeMissing = worktreeDir !== null && !existsSync(worktreeDir);
  const cwd = worktreeMissing ? projectDir : (worktreeDir ?? projectDir);

  // 兜底：不管理由是 worktree 失效回落、还是项目根本身被删/未挂载，只要**最终要用的 cwd**
  // 不存在，就在这里给出明确错误。否则下游 execSync 会报出误导性的
  // `posix_spawn '/bin/sh'` ENOENT（会被误判为“缺少 shell”），readdir 也会抛未捕获异常变 500。
  // 注意判空必须基于 cwd 而不是“有没有 worktree”，否则两者同时缺失时依然会漏过去。
  if (!existsSync(cwd)) {
    return {
      error: { code: 'PROJECT_DIR_MISSING', message: `工作目录不存在：${cwd}` },
      status: 409,
    } as const;
  }

  if (worktreeMissing) {
    return {
      cwd,
      sessionWorktreePath: null,
      gitConfigJson: project.gitConfigJson ?? '{}',
      missingWorktreePath: worktreeDir,
    };
  }

  return {
    cwd,
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
