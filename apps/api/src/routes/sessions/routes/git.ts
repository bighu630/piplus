import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { projects, sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { execFileSync } from 'node:child_process';
import { appendFile, access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { getDbPath } from '../../../db-context';
import { execGit, resolveProjectDir } from '../project-fs';

/**
 * Shell-free git invocation. Required for every argument that is free-form user text
 * (commit/tag messages, user identity, tokens): `execSync` interpolation lets
 * `$(...)`, backticks and quotes escape into the shell.
 */
function execGitFileArgs(cwd: string, args: string[], timeoutMs?: number): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    ...(timeoutMs ? { timeout: timeoutMs } : {}),
  }).toString();
}

/**
 * Remote to push to, resolved by git rather than hard-coded. Mirrors git's own push-remote
 * order: `branch.<current>.pushRemote` → `remote.pushDefault` → `branch.<current>.remote`
 * → first configured remote. `remote.pushDefault` outranks `branch.<current>.remote` on
 * purpose: without that, tags would land in a different repository than `git push` uses.
 */
function resolveGitRemote(cwd: string): string | null {
  const tryConfig = (key: string): string | null => {
    try {
      return execGitFileArgs(cwd, ['config', '--get', key]).trim() || null;
    } catch {
      return null;
    }
  };

  // Detached HEAD (`rev-parse --abbrev-ref HEAD` → `HEAD`) has no branch.* config to read.
  let currentBranch: string | null = null;
  try {
    const current = execGitFileArgs(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (current && current !== 'HEAD') currentBranch = current;
  } catch {
    // a repository without commits — same fallback as detached HEAD
  }

  const branchConfig = (key: string): string | null =>
    currentBranch ? tryConfig(`branch.${currentBranch}.${key}`) : null;

  const preferred =
    branchConfig('pushRemote') ?? tryConfig('remote.pushDefault') ?? branchConfig('remote');
  if (preferred) return preferred;

  try {
    const first = execGitFileArgs(cwd, ['remote'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0];
    return first ?? null;
  } catch {
    return null;
  }
}

/**
 * name → sha for every tag on the remote. Annotated tags make `ls-remote` print an extra
 * `refs/tags/<name>^{}` line (the dereferenced commit); it is skipped so each tag appears once
 * and its sha matches the local `%(objectname)` — the comparison that defines "unpushed".
 */
function listRemoteTagShas(cwd: string, remote: string, timeoutMs?: number): Map<string, string> {
  // `--` terminates options so a remote whose name looks like a flag cannot change the command.
  const out = execGitFileArgs(cwd, ['ls-remote', '--tags', '--', remote], timeoutMs);
  const shas = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    if (ref.endsWith('^{}')) continue;
    if (!ref.startsWith('refs/tags/')) continue;
    shas.set(ref.slice('refs/tags/'.length), sha.trim());
  }
  return shas;
}

/** Local tag name → object sha, using the same `%(objectname)` value as the list endpoint. */
function listLocalTagShas(cwd: string): Map<string, string> {
  // A literal tab cannot appear in a ref name, so it is a safe separator for tag names
  // (`git tag --format` does not expand `%x09`, so the tab is embedded in the argv string).
  const out = execGitFileArgs(cwd, ['tag', '--list', '--format=%(refname:lstrip=2)\t%(objectname)']);
  const shas = new Map<string, string>();
  for (const line of out.split('\n')) {
    const [name, sha] = line.split('\t');
    if (name && sha) shas.set(name.trim(), sha.trim());
  }
  return shas;
}

/**
 * trim → drop a leading `refs/tags/` → validate. A leading `-` is rejected as well: it would be
 * parsed as a git option (`git tag -f`, `git push --force`) and could move/overwrite tags.
 */
function validateTagName(
  raw: unknown,
): { name: string } | { error: { code: 'EMPTY_TAG_NAME' | 'INVALID_TAG_NAME'; message: string } } {
  const name = String(raw ?? '').trim().replace(/^refs\/tags\//, '');
  if (!name) {
    return { error: { code: 'EMPTY_TAG_NAME', message: 'Tag name is required' } };
  }
  if (name.startsWith('-') || !/^[a-zA-Z0-9._\-/]+$/.test(name)) {
    return { error: { code: 'INVALID_TAG_NAME', message: 'Tag name contains invalid characters' } };
  }
  return { name };
}

/** True when HEAD is not on a branch (git symbolic-ref fails on a detached HEAD). */
function isDetachedHead(cwd: string): boolean {
  try {
    execGit(cwd, 'symbolic-ref -q HEAD');
    return false;
  } catch {
    return true;
  }
}

/** Names of every tag pointing at the current HEAD (all of them, not just the closest one). */
function tagsPointingAtHead(cwd: string): string[] {
  try {
    return execGit(cwd, "tag --points-at HEAD --format='%(refname:lstrip=2)'")
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function shortHeadSha(cwd: string): string | null {
  try {
    return execGit(cwd, 'rev-parse --short HEAD').trim() || null;
  } catch {
    return null;
  }
}

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
        opts.push('-c', `http.extraheader=AUTHORIZATION: Basic ${encoded}`);
      }
      const stdout = execGitFileArgs(cwd, [...opts, 'push']);
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
      execGitFileArgs(cwd, ['add', '-A']);
      const cfg = JSON.parse(resolved.gitConfigJson || '{}');
      const opts: string[] = [];
      if (cfg.userName) opts.push('-c', `user.name=${cfg.userName}`);
      if (cfg.userEmail) opts.push('-c', `user.email=${cfg.userEmail}`);
      // argv form: the message and identity never pass through a shell, so `$(...)`, backticks
      // and quotes stay literal commit-message bytes instead of being executed.
      const stdout = execGitFileArgs(cwd, [...opts, 'commit', '-m', message]);
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
        // Detached HEAD makes `git branch` emit a pseudo entry such as
        // "(HEAD detached at v2.0.0)". It is not a real branch, so drop it.
        .filter((line: string) => !/^\s*\(HEAD detached (at|from) /.test(line))
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

      const detached = isDetachedHead(cwd);
      return c.json({
        session_id: sessionId,
        cwd,
        current_branch: currentBranch,
        branches: annotatedBranches,
        session_worktree_path: resolved.sessionWorktreePath,
        detached,
        detached_ref: detached ? (tagsPointingAtHead(cwd)[0] ?? shortHeadSha(cwd)) : null,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'GIT_ERROR', message } }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/tags:
   *   get:
   *     summary: 获取项目 Git 标签列表及 detached HEAD 状态
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 返回项目标签列表，并标记当前是否 detached HEAD 以及哪些标签指向当前提交。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   *       500:
   *         description: Git 操作失败。
   */
  app.get('/api/v1/sessions/:sessionId/git/tags', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      const detached = isDetachedHead(cwd);
      const pointingAtHead = new Set(detached ? tagsPointingAtHead(cwd) : []);

      // The sha comes from the tab-separated `%(refname:lstrip=2)\t%(objectname)` listing:
      // a ref name cannot contain a tab, while `|||` *is* legal in a tag message. Keeping
      // `%(objectname)` in this `|||` format made a subject containing `|||` shift the field
      // and expose a fragment of the message as the sha (a permanent "unpushed" badge).
      const localShas = listLocalTagShas(cwd);
      const output = execGit(
        cwd,
        `tag --list --sort=-creatordate --format='%(refname:lstrip=2)|||%(objecttype)|||%(creatordate:short)|||%(subject)'`,
      );
      const tags = output
        .split('\n')
        .filter(Boolean)
        .map((line: string) => {
          const [name = '', objecttype = '', date = '', subject = ''] = line.split('|||');
          const tagName = name.trim();
          return {
            name: tagName,
            is_current: pointingAtHead.has(tagName),
            is_annotated: objecttype.trim() === 'tag',
            date: date.trim(),
            subject: subject.trim(),
            // annotated tag → tag object sha; lightweight tag → commit sha. Both equal what
            // `git ls-remote --tags <remote>` advertises for `refs/tags/<name>`.
            sha: localShas.get(tagName) ?? '',
          };
        })
        .filter((tag) => Boolean(tag.name));

      return c.json({ session_id: sessionId, cwd, detached, tags });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: { code: 'GIT_ERROR', message } }, 500);
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/tags:
   *   post:
   *     summary: 在 HEAD 上创建 Git 标签
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 根据是否提供 message 创建附注标签或轻量标签。名称经过校验，命令不经 shell。
   *     responses:
   *       200:
   *         description: 创建成功。
   *       400:
   *         description: 标签名为空或含非法字符。
   *       500:
   *         description: Git 创建失败（如标签已存在）。
   */
  app.post('/api/v1/sessions/:sessionId/git/tags', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));

    const parsed = validateTagName((body as { name?: unknown }).name);
    if ('error' in parsed) return c.json({ error: parsed.error }, 400);
    const name = parsed.name;
    const message = String((body as { message?: unknown }).message ?? '').trim();

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    try {
      // argv form keeps the free-form tag message away from the shell.
      const argv = message ? ['tag', '-a', name, '-m', message] : ['tag', name];
      const stdout = execGitFileArgs(cwd, argv);
      return c.json({
        session_id: sessionId,
        cwd,
        result: 'ok',
        stdout: stdout.trim(),
        name,
        annotated: Boolean(message),
      });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json(
        {
          session_id: sessionId,
          cwd,
          result: 'error',
          stderr,
          name,
          error: { code: 'TAG_CREATE_FAILED', message: stderr },
        },
        500,
      );
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/remote-tags:
   *   get:
   *     summary: 获取远程 Git 标签状态
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 读取远程 tag 列表用于计算「未推送」状态。远程不可用时降级返回 remote_ok=false。
   *     responses:
   *       200:
   *         description: 查询完成（远程不可用时 remote_ok 为 false）。
   */
  app.get('/api/v1/sessions/:sessionId/git/remote-tags', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    // Remote state is best effort: the Git page must keep rendering, so every failure (no
    // remote, network, auth) degrades to `remote_ok: false` instead of a 500.
    const remote = resolveGitRemote(cwd);
    if (!remote) {
      return c.json({
        session_id: sessionId,
        cwd,
        remote_ok: false,
        remote: null,
        error: 'No git remote is configured',
        tags: [],
      });
    }

    try {
      const shas = listRemoteTagShas(cwd, remote, 10_000);
      const tags = [...shas.entries()]
        .map(([name, sha]) => ({ name, sha }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return c.json({ session_id: sessionId, cwd, remote_ok: true, remote, error: null, tags });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ session_id: sessionId, cwd, remote_ok: false, remote, error: message, tags: [] });
    }
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/git/tags/push:
   *   post:
   *     summary: 推送 Git 标签到远程
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 推送指定标签；names 省略时只推送与远程 sha 不一致的标签。永不使用 --force。
   *     responses:
   *       200:
   *         description: 推送成功或无需推送。
   *       400:
   *         description: 无可用 remote 或标签名非法。
   *       500:
   *         description: 推送失败（如远程已存在同名标签且不一致）。
   */
  app.post('/api/v1/sessions/:sessionId/git/tags/push', async (c) => {
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const rawNames = (body as { names?: unknown }).names;

    // An explicit list is validated up front; an empty/absent list means "all unpushed tags".
    let requested: string[] | null = null;
    if (Array.isArray(rawNames) && rawNames.length > 0) {
      requested = [];
      for (const raw of rawNames) {
        // A non-string scalar must not be coerced into a tag name (`String(1234)` → 1234 →
        // `src refspec refs/tags/1234 does not match any` and a 500 instead of a 400).
        if (typeof raw !== 'string') {
          return c.json({ error: { code: 'INVALID_NAMES', message: 'names must be an array of tag names' } }, 400);
        }
        const parsed = validateTagName(raw);
        if ('error' in parsed) return c.json({ error: parsed.error }, 400);
        requested.push(parsed.name);
      }
      // Duplicates would produce repeated refspecs, which git rejects for the same ref.
      requested = [...new Set(requested)];
    } else if (rawNames !== undefined && rawNames !== null && !Array.isArray(rawNames)) {
      // A malformed shape must not silently expand to "push every unpushed tag".
      return c.json({ error: { code: 'INVALID_NAMES', message: 'names must be an array of tag names' } }, 400);
    }

    const resolved = resolveProjectDir(c, userId, sessionId);
    if ('error' in resolved) return c.json({ error: resolved.error }, resolved.status);
    const cwd = resolved.cwd;

    const remote = resolveGitRemote(cwd);
    if (!remote) {
      return c.json({ error: { code: 'NO_REMOTE', message: 'No git remote is configured' } }, 400);
    }

    try {
      let toPush: string[];
      if (requested) {
        toPush = requested;
      } else {
        // "Unpushed" = the remote is missing the tag or advertises a different object sha.
        const localShas = listLocalTagShas(cwd);
        const remoteShas = listRemoteTagShas(cwd, remote, 10_000);
        toPush = [...localShas.entries()]
          .filter(([name, sha]) => remoteShas.get(name) !== sha)
          .map(([name]) => name)
          .sort();
      }

      if (toPush.length === 0) {
        return c.json({
          session_id: sessionId,
          cwd,
          result: 'ok',
          stdout: 'Everything up-to-date.',
          pushed: [],
          remote,
        });
      }

      const cfg = JSON.parse(resolved.gitConfigJson || '{}');
      const opts: string[] = [];
      if (cfg.token) {
        const encoded = Buffer.from(`token:${cfg.token}`).toString('base64');
        opts.push('-c', `http.extraheader=AUTHORIZATION: Basic ${encoded}`);
      }
      const refspecs = toPush.map((name) => `refs/tags/${name}:refs/tags/${name}`);
      // A tag refspec needs an explicit remote; no --force, so a conflicting remote tag makes
      // git reject the update instead of silently overwriting it. `--` keeps a remote whose
      // name looks like an option (e.g. `--force`) from being parsed as one.
      const stdout = execGitFileArgs(cwd, [...opts, 'push', '--', remote, ...refspecs]);
      return c.json({
        session_id: sessionId,
        cwd,
        result: 'ok',
        stdout: stdout.trim() || 'Everything up-to-date.',
        pushed: toPush,
        remote,
      });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json(
        {
          session_id: sessionId,
          cwd,
          result: 'error',
          stderr,
          pushed: [],
          remote,
          error: { code: 'TAG_PUSH_FAILED', message: stderr },
        },
        500,
      );
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
   *     summary: 切换到指定 Git 分支或标签
   *     tags: [Sessions, Git]
   *     security:
   *       - bearerAuth: []
   *     description: 切换到指定分支（type 省略或为 branch）或标签（type 为 tag，检出后处于 detached HEAD）。
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
    // `ref` takes precedence; `branch` is the legacy field kept for backward compatibility.
    const branch = String((body as { ref?: string; branch?: string }).ref ?? (body as { branch?: string }).branch ?? '').trim();
    const refType: 'branch' | 'tag' = (body as { type?: string }).type === 'tag' ? 'tag' : 'branch';

    if (!branch) {
      return c.json({ error: { code: 'EMPTY_REF', message: 'Ref name is required' } }, 400);
    }

    // Validate ref name format (allow letters, numbers, dots, hyphens, underscores, slashes).
    // A leading '-' is rejected as well: `git checkout -f` would be parsed as a git option and
    // can silently discard local changes.
    if (branch.startsWith('-') || !/^[a-zA-Z0-9._\-/]+$/.test(branch)) {
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
    if (refType === 'branch') {
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
      // Tag refs use the fully qualified refs/tags/<name> form: it disambiguates from a
      // same-named branch, guarantees a detached HEAD and can never be parsed as an option.
      const stdout = refType === 'tag'
        ? execGit(mainCwd, `checkout refs/tags/${branch}`)
        : execGit(mainCwd, `checkout "${branch.replace(/"/g, '\\"')}"`);
      return c.json({ session_id: sessionId, cwd: mainCwd, result: 'ok', stdout: stdout.trim(), branch });
    } catch (err: unknown) {
      const stderr = err instanceof Error && 'stderr' in err ? String((err as any).stderr ?? err.message) : String(err);
      return c.json(
        {
          session_id: sessionId,
          cwd: mainCwd,
          result: 'error',
          stderr,
          branch,
          // `error` is append-only: the web client's request() throws on non-2xx and reads
          // `body.error.message`, so git's stderr must be duplicated there to surface it.
          error: { code: 'CHECKOUT_FAILED', message: stderr },
        },
        500,
      );
    }
  });
}
