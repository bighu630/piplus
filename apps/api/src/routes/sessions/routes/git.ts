import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { projects, sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { appendFile, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../../../db-context';
import { execGit, resolveProjectDir } from '../project-fs';

export function registerGitRoutes(app: Hono) {
  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git-diff:
   *   get:
   *     summary: 获取会话所属项目的 Git Diff
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 在会话所属项目目录执行 git diff，并返回当前工作区差异文本。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/git-diff', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    let diff = '';
    try {
      diff = execGit(cwd, 'diff');
    } catch (err: unknown) {
      if (err instanceof Error && 'stdout' in err) {
        diff = String((err as any).stdout ?? '');
      }
    }

    return c.json({ session_id: sessionId, diff, cwd });
  });

  app.post('/api/v1/sessions/:sessionId/git/pull', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      const stdout = execGit(cwd, 'pull');
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim() || 'Already up to date.' });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr }, 500);
    }
  });

  app.post('/api/v1/sessions/:sessionId/git/push', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      const cfg = JSON.parse(resolved.gitConfigJson || '{}');
      const opts: string[] = [];
      if (cfg.token) {
        const encoded = Buffer.from(`token:${cfg.token}`).toString('base64');
        opts.push('-c', `http.extraheader="AUTHORIZATION: Basic ${encoded}"`);
      }
      const stdout = execGit(cwd, ...opts, 'push');
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim() || 'Everything up-to-date.' });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr }, 500);
    }
  });

  app.post('/api/v1/sessions/:sessionId/git/commit', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const message = String((body as { message?: string }).message ?? '').trim();

    if (!message) {
      return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Commit message is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      execGit(cwd, 'add -A');
      const cfg = JSON.parse(resolved.gitConfigJson || '{}');
      const opts: string[] = [];
      if (cfg.userName) opts.push('-c', `user.name="${cfg.userName}"`);
      if (cfg.userEmail) opts.push('-c', `user.email="${cfg.userEmail}"`);
      const stdout = execGit(cwd, ...opts, `commit -m "${message.replace(/"/g, '\\"')}"`);
      return c.json({ session_id: sessionId, cwd, result: 'ok', stdout: stdout.trim() });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd, result: 'error', stderr }, 500);
    }
  });

  app.post('/api/v1/sessions/:sessionId/git/gitignore', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const filePath = String((body as { path?: string }).path ?? '').trim();

    if (!filePath) {
      return c.json({ error: { code: 'INVALID_PATH', message: 'Path is required' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);

    const gitignorePath = path.join(resolved.cwd, '.gitignore');
    const normalizedEntry = filePath.replace(/\\/g, '/');

    let existingContent = '';
    try {
      await access(gitignorePath, constants.R_OK);
      existingContent = await readFile(gitignorePath, 'utf8');
    } catch {
      // .gitignore doesn't exist yet, that's fine
    }

    const lines = existingContent.split('\n').map((l) => l.trim());
    if (lines.includes(normalizedEntry)) {
      return c.json({ session_id: sessionId, path: normalizedEntry, result: 'already_ignored' });
    }

    const entry = existingContent.endsWith('\n') || existingContent.length === 0
      ? `${normalizedEntry}\n`
      : `\n${normalizedEntry}\n`;

    await appendFile(gitignorePath, entry, 'utf8');
    return c.json({ session_id: sessionId, path: normalizedEntry, result: 'ok' });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/branches:
   *   get:
   *     summary: 获取项目 Git 分支列表及当前分支
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 返回项目当前 Git 分支列表及当前所在分支。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   *       500:
   *         description: Git 操作失败。
   */
  app.get('/api/v1/sessions/:sessionId/git/branches', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      // Get current branch
      const currentBranch = execGit(cwd, 'rev-parse --abbrev-ref HEAD').trim();

      // Get all local branches
      const branchOutput = execGit(cwd, 'branch --format=\'%(refname:short)|||%(HEAD)\' ');
      const branches = branchOutput
        .split('\n')
        .filter(Boolean)
        .map((line: string) => {
          const [name, headMarker] = line.split('|||');
          return { name: name.trim(), is_current: headMarker.trim() === '*' };
        });

      // Get worktree info to mark branches checked out in other worktrees
      const worktreeBranches = new Map<string, string>();
      try {
        // Normalize cwd to absolute path for reliable comparison with worktree paths
        const resolvedCwd = path.resolve(cwd);
        const worktreeOutput = execGit(cwd, 'worktree list');
        const wtLines = worktreeOutput.trim().split('\n').filter(Boolean);
        for (const line of wtLines) {
          // Format: <path> <hash> [<branch>] or (detached HEAD)
          const branchMatch = line.match(/\[(.+)\]$/);
          const pathMatch = line.match(/^(\S+)/);
          if (branchMatch && pathMatch) {
            const branchName = branchMatch[1];
            const wtPath = path.resolve(cwd, pathMatch[1]);
            // Skip the main worktree — its branch is already marked as is_current
            if (wtPath !== resolvedCwd) {
              worktreeBranches.set(branchName, wtPath);
            }
          }
        }
      } catch {
        // If worktree list fails, ignore and continue without worktree info
      }

      // Annotate branches with worktree info
      const annotatedBranches = branches.map((b: { name: string; is_current: boolean }) => ({
        ...b,
        is_worktree: worktreeBranches.has(b.name),
        worktree_path: worktreeBranches.get(b.name) ?? null,
      }));

      return c.json({ session_id: sessionId, cwd, current_branch: currentBranch, branches: annotatedBranches, session_worktree_path: resolved.sessionWorktreePath });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'GIT_ERROR', message } }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/commits:
   *   get:
   *     summary: 获取 Git 提交历史
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 获取指定会话所在仓库的 Git 提交历史。
   *     parameters:
   *       - in: query
   *         name: limit
   *         schema:
   *           type: integer
   *           default: 50
   *         description: 最大提交数（上限 200）。
   *     responses:
   *       200:
   *         description: 返回提交列表。
   *       500:
   *         description: Git 操作失败。
   */
  app.get('/api/v1/sessions/:sessionId/git/commits', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

    try {
      const output = execGit(
        cwd,
        'log',
        '--branches',
        `--max-count=${limit}`,
        `'--format=%H|||%s|||%an|||%ai|||%D'`,
      );
      const commits = output
        .split('\n')
        .filter(Boolean)
        .map((line: string) => {
          const [hash, message, author, date, refs] = line.split('|||');
          return { hash, message, author, date, refs: refs || '' };
        });

      return c.json({ session_id: sessionId, cwd, commits });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'GIT_ERROR', message } }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/show:
   *   get:
   *     summary: 查看单个 Git 提交详情
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 获取指定提交的详情，包括 diff。
   *     parameters:
   *       - in: query
   *         name: hash
   *         required: true
   *         schema:
   *           type: string
   *         description: 提交哈希。
   *     responses:
   *       200:
   *         description: 返回提交详情。
   *       400:
   *         description: 缺少 hash 参数。
   *       500:
   *         description: Git 操作失败。
   */
  app.get('/api/v1/sessions/:sessionId/git/show', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const hash = String(c.req.query('hash') ?? '').trim();
    if (!hash) {
      return c.json({ error: { code: 'MISSING_HASH', message: 'Hash parameter is required' } }, 400);
    }
    if (!/^[a-f0-9]{7,40}$/i.test(hash)) {
      return c.json({ error: { code: 'INVALID_HASH', message: 'Invalid commit hash format' } }, 400);
    }

    try {
      const output = execGit(cwd, 'show', hash, `'--format=%H|||%s|||%an|||%ai'`, '--patch');
      const lines = output.split('\n');
      const metaLine = lines[0];
      const [metaHash, message, author, date] = metaLine.split('|||');
      const diffLines = lines.slice(1);
      const diffStartIdx = diffLines.findIndex((l) => l.startsWith('diff --git'));
      const diff = diffStartIdx >= 0 ? diffLines.slice(diffStartIdx).join('\n') : '';

      return c.json({
        session_id: sessionId,
        cwd,
        hash: metaHash || hash,
        message,
        author,
        date,
        diff,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'GIT_ERROR', message } }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/checkout:
   *   post:
   *     summary: 切换到指定 Git 分支
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 切换到指定分支。
   *     responses:
   *       200:
   *         description: 切换成功。
   *       400:
   *         description: 分支名为空。
   *       404:
   *         description: 会话不存在或无访问权限。
   *       500:
   *         description: Git 操作失败。
   */
  app.post('/api/v1/sessions/:sessionId/git/checkout', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const branch = String((body as { branch?: string }).branch ?? '').trim();

    if (!branch) {
      return c.json({ error: { code: 'EMPTY_BRANCH', message: 'Branch name is required' } }, 400);
    }

    // Validate branch name format (allow letters, numbers, dots, hyphens, underscores, slashes)
    if (!/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
      return c.json({ error: { code: 'INVALID_BRANCH', message: 'Branch name contains invalid characters' } }, 400);
    }

    // We need session and project directly (not via resolveProjectDir) because the
    // checkout logic needs the main project directory and the session for worktree updates.
    const db = createDb(`file:${getDbPath()}`);
    const [session] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = db.select({ projectPath: projects.projectPath, createdBy: projects.createdBy }).from(projects).where(eq(projects.id, session.projectId)).limit(1).all();
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const mainCwd = project.projectPath || process.cwd();

    // Parse worktree list to check if the target branch is checked out in another worktree
    const resolvedMainCwd = path.resolve(mainCwd);
    let worktreePath: string | null = null;
    try {
      const worktreeOutput = execGit(mainCwd, 'worktree list');
      const wtLines = worktreeOutput.trim().split('\n').filter(Boolean);
      for (const line of wtLines) {
        const branchMatch = line.match(/\[(.+)\]$/);
        const pathMatch = line.match(/^(\S+)/);
        if (branchMatch && pathMatch) {
          const wtBranch = branchMatch[1];
          const wtPath = path.resolve(mainCwd, pathMatch[1]);
          // Skip the main worktree — its branch is handled by regular checkout
          if (wtBranch === branch && wtPath !== resolvedMainCwd) {
            worktreePath = wtPath;
            break;
          }
        }
      }
    } catch {
      // worktree list failed — fall back to normal checkout behavior
    }

    if (worktreePath) {
      // Branch is checked out in a worktree — update session worktree_path, no git checkout
      await db.update(sessions).set({ worktreePath, updatedAt: new Date() }).where(eq(sessions.id, sessionId)).run();
      return c.json({ session_id: sessionId, cwd: worktreePath, result: 'ok', stdout: `Switched to worktree at ${worktreePath}`, branch });
    }

    // Not a worktree branch — clear worktree_path if previously set, then checkout normally
    if (session.worktreePath) {
      await db.update(sessions).set({ worktreePath: null, updatedAt: new Date() }).where(eq(sessions.id, sessionId)).run();
    }

    try {
      const stdout = execGit(mainCwd, `checkout "${branch.replace(/"/g, '\\"')}"`);
      return c.json({ session_id: sessionId, cwd: mainCwd, result: 'ok', stdout: stdout.trim(), branch });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json({ session_id: sessionId, cwd: mainCwd, result: 'error', stderr, branch }, 500);
    }
  });
}
