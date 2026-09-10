import { describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../../app';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

type TestApp = ReturnType<typeof createApp>;
type GitResult = { code: number; stdout: string; stderr: string };

function git(cwd: string, ...args: string[]): GitResult {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  return {
    code: proc.exitCode ?? -1,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

function mustGit(cwd: string, ...args: string[]): string {
  const result = git(cwd, ...args);
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function makeRepo(label: string): Promise<string> {
  const dir = path.join('/tmp', `piplus-git-${label}-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  mustGit(dir, 'init', '-b', 'main');
  // Without an identity `git commit` fails in a fresh temp repo.
  mustGit(dir, 'config', 'user.email', 'piplus-test@example.com');
  mustGit(dir, 'config', 'user.name', 'Piplus Test');
  return dir;
}

async function commitFile(dir: string, fileName: string, content: string, message: string): Promise<string> {
  await Bun.write(path.join(dir, fileName), content);
  mustGit(dir, 'add', '-A');
  mustGit(dir, 'commit', '-m', message);
  return mustGit(dir, 'rev-parse', 'HEAD');
}

async function seedSession(repoDir: string): Promise<{ app: TestApp; sessionId: string }> {
  const dbPath = `/tmp/piplus-git-db-${crypto.randomUUID()}.sqlite`;
  createSeedDb(dbPath);
  Bun.env.DATABASE_URL = `file:${dbPath}`;
  const app = createApp();

  const projectRes = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify({ name: 'Git Tag Test Project', mode: 'existing', path: repoDir }),
  });
  expect(projectRes.status).toBe(201);
  const projectBody = (await projectRes.json()) as { sessionId: string };
  return { app, sessionId: projectBody.sessionId };
}

async function apiGet(app: TestApp, sessionId: string, endpoint: 'branches' | 'tags') {
  const res = await app.request(`/api/v1/sessions/${sessionId}/git/${endpoint}`, {
    headers: { 'x-user-id': 'user_seed' },
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function apiCheckout(app: TestApp, sessionId: string, payload: Record<string, unknown>) {
  const res = await app.request(`/api/v1/sessions/${sessionId}/git/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
}

describe('git tags and detached HEAD', () => {
  test('git/tags returns annotated and lightweight tags with is_annotated flags', async () => {
    const repo = await makeRepo('tags-list');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');

    const { app, sessionId } = await seedSession(repo);
    const { status, body } = await apiGet(app, sessionId, 'tags');

    expect(status).toBe(200);
    expect(body.session_id).toBe(sessionId);
    expect(body.cwd).toBe(repo);
    expect(body.detached).toBe(false);
    expect(body.tags).toHaveLength(2);

    const lightweight = body.tags.find((t: any) => t.name === 'v1.0.0');
    const annotated = body.tags.find((t: any) => t.name === 'v2.0.0');
    expect(lightweight).toBeDefined();
    expect(annotated).toBeDefined();
    expect(lightweight.is_annotated).toBe(false);
    expect(annotated.is_annotated).toBe(true);
    // lightweight tag subject is the commit subject; annotated tag subject is the tag message
    expect(lightweight.subject).toBe('first commit');
    expect(annotated.subject).toBe('release 2.0');
    expect(lightweight.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(annotated.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    await rm(repo, { recursive: true, force: true });
  });

  test('git/tags marks no tag as current while HEAD is on a branch', async () => {
    const repo = await makeRepo('tags-not-detached');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'checkout', '-b', 'feature');
    const featureSha = await commitFile(repo, 'b.txt', 'feature', 'feature commit');
    // A tag pointing at the current commit must still not be "current" on a branch.
    mustGit(repo, 'tag', '-a', 'v-feature', '-m', 'feature tag');
    mustGit(repo, 'tag', 'v-light');
    expect(mustGit(repo, 'rev-parse', 'HEAD')).toBe(featureSha);

    const { app, sessionId } = await seedSession(repo);
    const { status, body } = await apiGet(app, sessionId, 'tags');

    expect(status).toBe(200);
    expect(body.detached).toBe(false);
    expect(body.tags.length).toBe(2);
    expect(body.tags.every((t: any) => t.is_current === false)).toBe(true);
    expect(mustGit(repo, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/feature');

    await rm(repo, { recursive: true, force: true });
  });

  test('git/tags marks the checked out tag as current after tag checkout', async () => {
    const repo = await makeRepo('tags-current');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');

    const { app, sessionId } = await seedSession(repo);
    const checkout = await apiCheckout(app, sessionId, { ref: 'v2.0.0', type: 'tag' });
    expect(checkout.status).toBe(200);

    const { status, body } = await apiGet(app, sessionId, 'tags');
    expect(status).toBe(200);
    expect(body.detached).toBe(true);
    const currentNames = body.tags.filter((t: any) => t.is_current).map((t: any) => t.name);
    expect(currentNames).toEqual(['v2.0.0']);
    const v1 = body.tags.find((t: any) => t.name === 'v1.0.0');
    expect(v1.is_current).toBe(false);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/checkout with type=tag detaches HEAD (also when a branch has the same name)', async () => {
    const repo = await makeRepo('checkout-tag');
    const firstSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');
    const tagCommit = mustGit(repo, 'rev-parse', 'refs/tags/v2.0.0^{commit}');
    // Same-named branch at an older commit: plain `git checkout v2.0.0` would land on the
    // branch, so the route must use the fully qualified refs/tags/<name> form.
    mustGit(repo, 'branch', 'v2.0.0', firstSha);

    const { app, sessionId } = await seedSession(repo);
    const res = await apiCheckout(app, sessionId, { ref: 'v2.0.0', type: 'tag' });

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.cwd).toBe(repo);
    expect(res.body.result).toBe('ok');
    expect(res.body.branch).toBe('v2.0.0');

    // Detached: `git symbolic-ref -q HEAD` must fail.
    const symbolic = git(repo, 'symbolic-ref', '-q', 'HEAD');
    expect(symbolic.code).not.toBe(0);
    // And HEAD must be the tag's commit, not the same-named branch's commit.
    expect(mustGit(repo, 'rev-parse', 'HEAD')).toBe(tagCommit);

    await rm(repo, { recursive: true, force: true });
  });

  test('git/tags marks every tag pointing at HEAD as current', async () => {
    const repo = await makeRepo('checkout-multi-tags');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');
    mustGit(repo, 'tag', 'v2.1.0');

    const { app, sessionId } = await seedSession(repo);
    const checkout = await apiCheckout(app, sessionId, { ref: 'v2.1.0', type: 'tag' });
    expect(checkout.status).toBe(200);

    const { body } = await apiGet(app, sessionId, 'tags');
    expect(body.detached).toBe(true);
    const currentNames = body.tags
      .filter((t: any) => t.is_current)
      .map((t: any) => t.name)
      .sort();
    expect(currentNames).toEqual(['v2.0.0', 'v2.1.0']);

    await rm(repo, { recursive: true, force: true });
  });

  test('git/branches reports detached and detached_ref (tag name or short sha)', async () => {
    const repo = await makeRepo('branches-detached');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    const secondSha = await commitFile(repo, 'a.txt', 'two', 'second commit');

    const { app, sessionId } = await seedSession(repo);

    const onBranch = await apiGet(app, sessionId, 'branches');
    expect(onBranch.status).toBe(200);
    expect(onBranch.body.detached).toBe(false);
    expect(onBranch.body.detached_ref).toBeNull();

    const checkout = await apiCheckout(app, sessionId, { ref: 'v1.0.0', type: 'tag' });
    expect(checkout.status).toBe(200);

    const detachedAtTag = await apiGet(app, sessionId, 'branches');
    expect(detachedAtTag.body.detached).toBe(true);
    expect(detachedAtTag.body.detached_ref).toBe('v1.0.0');

    // Detached at a commit with no tag → fall back to the short sha.
    mustGit(repo, 'checkout', '--detach', secondSha);
    const detachedAtSha = await apiGet(app, sessionId, 'branches');
    expect(detachedAtSha.body.detached).toBe(true);
    expect(detachedAtSha.body.detached_ref).toBe(mustGit(repo, 'rev-parse', '--short', 'HEAD'));

    await rm(repo, { recursive: true, force: true });
  });

  test('git/checkout validates the ref name and keeps the legacy branch field working', async () => {
    const repo = await makeRepo('checkout-validation');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    const { app, sessionId } = await seedSession(repo);

    const emptyRef = await apiCheckout(app, sessionId, { ref: '   ' });
    expect(emptyRef.status).toBe(400);
    expect(emptyRef.body.error.code).toBe('EMPTY_REF');

    const missingRef = await apiCheckout(app, sessionId, {});
    expect(missingRef.status).toBe(400);
    expect(missingRef.body.error.code).toBe('EMPTY_REF');

    // `-f` must be rejected before git runs: `git checkout -f` silently discards local changes.
    await Bun.write(path.join(repo, 'a.txt'), 'local modification');
    const dashRef = await apiCheckout(app, sessionId, { ref: '-f', type: 'tag' });
    expect(dashRef.status).toBe(400);
    expect(dashRef.body.error.code).toBe('INVALID_BRANCH');
    // The local modification must survive the rejected request.
    expect(mustGit(repo, 'status', '--porcelain')).toBe('M a.txt');
    expect(await Bun.file(path.join(repo, 'a.txt')).text()).toBe('local modification');

    const invalidRef = await apiCheckout(app, sessionId, { ref: 'bad name!' });
    expect(invalidRef.status).toBe(400);
    expect(invalidRef.body.error.code).toBe('INVALID_BRANCH');

    // Legacy `branch` field (no `ref`) still works.
    mustGit(repo, 'checkout', '--', 'a.txt');
    const legacy = await apiCheckout(app, sessionId, { branch: 'main' });
    expect(legacy.status).toBe(200);
    expect(legacy.body.branch).toBe('main');
    expect(legacy.body.cwd).toBe(repo);
    expect(mustGit(repo, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');

    await rm(repo, { recursive: true, force: true });
  });

  test('worktree checkout regression: branches metadata, cwd switch, clearing and tag isolation', async () => {
    const repo = await makeRepo('worktree-regression');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v0.1.0');
    mustGit(repo, 'branch', 'feature-a');
    const worktreeDir = `${repo}-wt`;
    mustGit(repo, 'worktree', 'add', worktreeDir, 'feature-a');

    const { app, sessionId } = await seedSession(repo);

    // Before checkout: the branch is flagged as a worktree branch, main stays current.
    const before = await apiGet(app, sessionId, 'branches');
    expect(before.status).toBe(200);
    expect(before.body.session_worktree_path).toBeNull();
    const featureBefore = before.body.branches.find((b: any) => b.name === 'feature-a');
    expect(featureBefore).toBeDefined();
    expect(featureBefore.is_worktree).toBe(true);
    expect(featureBefore.worktree_path).toBe(worktreeDir);
    expect(featureBefore.is_current).toBe(false);
    expect(before.body.branches.find((b: any) => b.name === 'main').is_current).toBe(true);

    // Checkout the worktree branch: no git checkout, the session cwd moves to the worktree.
    const checkout = await apiCheckout(app, sessionId, { ref: 'feature-a' });
    expect(checkout.status).toBe(200);
    expect(checkout.body.result).toBe('ok');
    expect(checkout.body.cwd).toBe(worktreeDir);
    expect(mustGit(repo, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');

    const afterCheckout = await apiGet(app, sessionId, 'branches');
    expect(afterCheckout.body.cwd).toBe(worktreeDir);
    expect(afterCheckout.body.session_worktree_path).toBe(worktreeDir);

    // Tag mode must not match worktrees nor write session.worktree_path; it clears it instead.
    const tagCheckout = await apiCheckout(app, sessionId, { ref: 'v0.1.0', type: 'tag' });
    expect(tagCheckout.status).toBe(200);
    expect(tagCheckout.body.cwd).toBe(repo);
    const afterTag = await apiGet(app, sessionId, 'branches');
    expect(afterTag.body.session_worktree_path).toBeNull();
    expect(afterTag.body.cwd).toBe(repo);
    expect(afterTag.body.detached).toBe(true);

    // Switching back to the main branch still clears worktree_path.
    const back = await apiCheckout(app, sessionId, { ref: 'main' });
    expect(back.status).toBe(200);
    const afterBack = await apiGet(app, sessionId, 'branches');
    expect(afterBack.body.session_worktree_path).toBeNull();
    expect(afterBack.body.detached).toBe(false);
    expect(afterBack.body.current_branch).toBe('main');
    expect(mustGit(repo, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');

    await rm(repo, { recursive: true, force: true });
    await rm(worktreeDir, { recursive: true, force: true });
  });
});
