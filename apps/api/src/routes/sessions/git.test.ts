import { afterEach, describe, expect, test } from 'bun:test';
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

/**
 * Temp paths created by this suite: /tmp repos, temp sqlite DBs and worktree dirs. Tracked so
 * afterEach can remove them unconditionally — a failing assertion mid-test must not leak files.
 */
const tempPaths: string[] = [];

function trackTempPath(p: string): string {
  tempPaths.push(p);
  return p;
}

afterEach(async () => {
  const paths = tempPaths.splice(0, tempPaths.length);
  for (const p of paths) {
    await rm(p, { recursive: true, force: true });
    // SQLite keeps sidecar files next to the database file.
    await rm(`${p}-wal`, { force: true });
    await rm(`${p}-shm`, { force: true });
    await rm(`${p}-journal`, { force: true });
  }
});

async function makeRepo(label: string): Promise<string> {
  const dir = trackTempPath(path.join('/tmp', `piplus-git-${label}-${crypto.randomUUID()}`));
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

async function seedSession(
  repoDir: string,
  gitConfig?: { userName?: string; userEmail?: string; token?: string },
): Promise<{ app: TestApp; sessionId: string }> {
  const dbPath = trackTempPath(`/tmp/piplus-git-db-${crypto.randomUUID()}.sqlite`);
  createSeedDb(dbPath);
  Bun.env.DATABASE_URL = `file:${dbPath}`;
  const app = createApp();

  const projectRes = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify({
      name: 'Git Tag Test Project',
      mode: 'existing',
      path: repoDir,
      ...(gitConfig ? { git_config: gitConfig } : {}),
    }),
  });
  expect(projectRes.status).toBe(201);
  const projectBody = (await projectRes.json()) as { sessionId: string };
  return { app, sessionId: projectBody.sessionId };
}

/** A local bare repository used as `origin` — no test in this file touches the network. */
async function makeBareRemote(label: string): Promise<string> {
  const dir = trackTempPath(path.join('/tmp', `piplus-git-remote-${label}-${crypto.randomUUID()}.git`));
  await mkdir(dir, { recursive: true });
  mustGit(dir, 'init', '--bare', '-b', 'main');
  return dir;
}

/** A repo with several bare remotes, used to pin down the push-remote resolution priority. */
async function makeRepoWithRemotes(label: string, names: string[]): Promise<{ repo: string; remotes: Record<string, string> }> {
  const repo = await makeRepo(label);
  const remotes: Record<string, string> = {};
  for (const name of names) {
    const dir = await makeBareRemote(`${label}-${name}`);
    mustGit(repo, 'remote', 'add', name, dir);
    remotes[name] = dir;
  }
  return { repo, remotes };
}

async function apiGet(app: TestApp, sessionId: string, endpoint: 'branches' | 'tags' | 'remote-tags') {
  const res = await app.request(`/api/v1/sessions/${sessionId}/git/${endpoint}`, {
    headers: { 'x-user-id': 'user_seed' },
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function apiPost(
  app: TestApp,
  sessionId: string,
  endpoint: 'tags' | 'tags/push' | 'commit' | 'checkout' | 'push',
  payload: Record<string, unknown>,
) {
  const res = await app.request(`/api/v1/sessions/${sessionId}/git/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function apiCheckout(app: TestApp, sessionId: string, payload: Record<string, unknown>) {
  return apiPost(app, sessionId, 'checkout', payload);
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

  test('git/tags keeps plain tag names when a same-named branch exists and checkout round-trips', async () => {
    const repo = await makeRepo('same-name-branch-tag');
    // Tag points at commit A; the same-named branch points at a different commit B.
    const tagSha = await commitFile(repo, 'a.txt', 'tag target', 'commit A (tag target)');
    mustGit(repo, 'tag', 'v2.0.0');
    const branchSha = await commitFile(repo, 'a.txt', 'branch target', 'commit B (branch target)');
    mustGit(repo, 'branch', 'v2.0.0', branchSha);
    expect(branchSha).not.toBe(tagSha);

    const { app, sessionId } = await seedSession(repo);

    // 1) The list endpoint must expose the plain tag name, never the disambiguated `tags/v2.0.0`.
    const listed = await apiGet(app, sessionId, 'tags');
    expect(listed.status).toBe(200);
    expect(listed.body.tags).toHaveLength(1);
    expect(listed.body.tags[0].name).toBe('v2.0.0');
    expect(listed.body.tags[0].is_current).toBe(false);

    // 2) Checkout with the name exactly as returned by the list endpoint must succeed.
    const checkout = await apiCheckout(app, sessionId, { ref: listed.body.tags[0].name, type: 'tag' });
    expect(checkout.status).toBe(200);

    // 3) HEAD must be at the tag's commit (commit A), not at the same-named branch's commit (B).
    expect(mustGit(repo, 'rev-parse', 'HEAD')).toBe(tagSha);
    expect(mustGit(repo, 'rev-parse', 'HEAD')).not.toBe(branchSha);

    // 4) The tag must now be flagged current — the display name and is_current share one source.
    const after = await apiGet(app, sessionId, 'tags');
    expect(after.status).toBe(200);
    expect(after.body.detached).toBe(true);
    expect(after.body.tags.find((t: any) => t.name === 'v2.0.0').is_current).toBe(true);
  });

  test('POST git/checkout reports git stderr via error.message and preserves local changes on failure', async () => {
    const repo = await makeRepo('checkout-dirty');
    await commitFile(repo, 'a.txt', 'base', 'base commit');
    mustGit(repo, 'checkout', '-b', 'other');
    await commitFile(repo, 'a.txt', 'other version', 'other commit');
    mustGit(repo, 'checkout', 'main');

    const { app, sessionId } = await seedSession(repo);

    // Dirty working tree: `git checkout other` must refuse to overwrite the local edit.
    await Bun.write(path.join(repo, 'a.txt'), 'local uncommitted work');
    const res = await apiCheckout(app, sessionId, { ref: 'other' });

    expect(res.status).toBe(500);
    expect(res.body.result).toBe('error');
    expect(typeof res.body.stderr).toBe('string');
    expect(res.body.stderr.length).toBeGreaterThan(0);
    expect(res.body.stderr).toContain('a.txt');
    // The web client reads `body.error.message` on non-2xx — this is what surfaces git stderr.
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe('CHECKOUT_FAILED');
    expect(typeof res.body.error.message).toBe('string');
    expect(res.body.error.message.length).toBeGreaterThan(0);
    expect(res.body.error.message).toContain('a.txt');

    // The failed checkout must not drop the local modification nor switch the ref.
    expect(mustGit(repo, 'symbolic-ref', '-q', 'HEAD')).toBe('refs/heads/main');
    expect(mustGit(repo, 'status', '--porcelain')).toBe('M a.txt');
    expect(await Bun.file(path.join(repo, 'a.txt')).text()).toBe('local uncommitted work');
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

    // Sanity guard: git really does emit a pseudo branch entry while detached, so the
    // assertions below stay meaningful rather than passing vacuously.
    expect(mustGit(repo, 'branch', '--format=%(refname:short)')).toContain('(HEAD detached at');
    // That pseudo entry must not surface as a fake branch, and no real branch is current.
    expect(detachedAtTag.body.branches.some((b: any) => b.name.startsWith('('))).toBe(false);
    expect(detachedAtTag.body.branches.every((b: any) => b.is_current === false)).toBe(true);
    expect(detachedAtTag.body.branches.map((b: any) => b.name)).toContain('main');

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
    // The shared validation must reject `-f` without `type` (branch mode) too.
    const dashRefBranchMode = await apiCheckout(app, sessionId, { ref: '-f' });
    expect(dashRefBranchMode.status).toBe(400);
    expect(dashRefBranchMode.body.error.code).toBe('INVALID_BRANCH');
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
    const worktreeDir = trackTempPath(`${repo}-wt`);
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

describe('git tag creation', () => {
  test('POST git/tags creates a lightweight tag at HEAD when no message is given', async () => {
    const repo = await makeRepo('tag-create-lightweight');
    const headSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    const { app, sessionId } = await seedSession(repo);

    const res = await apiPost(app, sessionId, 'tags', { name: 'v1.0.0' });

    expect(res.status).toBe(200);
    expect(res.body.session_id).toBe(sessionId);
    expect(res.body.cwd).toBe(repo);
    expect(res.body.result).toBe('ok');
    expect(res.body.name).toBe('v1.0.0');
    expect(res.body.annotated).toBe(false);
    // A lightweight tag points straight at the commit (no tag object is created).
    expect(mustGit(repo, 'cat-file', '-t', 'refs/tags/v1.0.0')).toBe('commit');
    expect(mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0')).toBe(headSha);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags creates an annotated tag and stores the message verbatim', async () => {
    const repo = await makeRepo('tag-create-annotated');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    const { app, sessionId } = await seedSession(repo);
    const message = 'release 1.0\n\nwith details';

    const res = await apiPost(app, sessionId, 'tags', { name: 'v1.0.0', message });

    expect(res.status).toBe(200);
    expect(res.body.annotated).toBe(true);
    // An annotated tag is a real tag object, not the commit it points at.
    expect(mustGit(repo, 'cat-file', '-t', 'refs/tags/v1.0.0')).toBe('tag');
    expect(mustGit(repo, 'tag', '-l', 'v1.0.0', '--format=%(contents)')).toBe(message);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags never executes shell metacharacters embedded in the tag message', async () => {
    const repo = await makeRepo('tag-create-injection');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    const dollarPwned = trackTempPath(`/tmp/piplus-git-tag-dollar-${crypto.randomUUID()}`);
    const backtickPwned = trackTempPath(`/tmp/piplus-git-tag-backtick-${crypto.randomUUID()}`);
    const message = `release $(touch ${dollarPwned}) \`touch ${backtickPwned}\` "quoted" $$HOME`;

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags', { name: 'v1.0.0', message });

    expect(res.status).toBe(200);
    expect(res.body.annotated).toBe(true);
    // Command substitution must stay inert: git receives the message as a plain argv entry.
    expect(await Bun.file(dollarPwned).exists()).toBe(false);
    expect(await Bun.file(backtickPwned).exists()).toBe(false);
    expect(mustGit(repo, 'tag', '-l', 'v1.0.0', '--format=%(contents)')).toBe(message);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags reports TAG_CREATE_FAILED when the tag already exists', async () => {
    const repo = await makeRepo('tag-create-duplicate');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    const { app, sessionId } = await seedSession(repo);

    const res = await apiPost(app, sessionId, 'tags', { name: 'v1.0.0' });

    expect(res.status).toBe(500);
    expect(res.body.result).toBe('error');
    expect(res.body.name).toBe('v1.0.0');
    expect(res.body.error.code).toBe('TAG_CREATE_FAILED');
    expect(String(res.body.error.message).length).toBeGreaterThan(0);
    // The original tag survives the failed attempt.
    expect(mustGit(repo, 'cat-file', '-t', 'refs/tags/v1.0.0')).toBe('commit');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags validates the tag name and strips a refs/tags/ prefix', async () => {
    const repo = await makeRepo('tag-create-validation');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    const { app, sessionId } = await seedSession(repo);

    const empty = await apiPost(app, sessionId, 'tags', { name: '   ' });
    expect(empty.status).toBe(400);
    expect(empty.body.error.code).toBe('EMPTY_TAG_NAME');

    const missing = await apiPost(app, sessionId, 'tags', {});
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('EMPTY_TAG_NAME');

    // `-f` must be rejected before git runs: `git tag -f` would silently move an existing tag.
    const dash = await apiPost(app, sessionId, 'tags', { name: '-f' });
    expect(dash.status).toBe(400);
    expect(dash.body.error.code).toBe('INVALID_TAG_NAME');

    const invalid = await apiPost(app, sessionId, 'tags', { name: 'bad name!' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('INVALID_TAG_NAME');

    // None of the rejected requests may have created a tag.
    expect(mustGit(repo, 'tag', '-l')).toBe('');

    // A fully qualified name is accepted and the prefix is stripped.
    const prefixed = await apiPost(app, sessionId, 'tags', { name: 'refs/tags/v9' });
    expect(prefixed.status).toBe(200);
    expect(prefixed.body.name).toBe('v9');
    expect(mustGit(repo, 'tag', '-l')).toBe('v9');

    await rm(repo, { recursive: true, force: true });
  });
});

describe('git tag sha and remote status', () => {
  test('git/remote-tags degrades to remote_ok=false when the remote is unreachable', async () => {
    const repo = await makeRepo('remote-tags-unreachable');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    const missingRemote = trackTempPath(`/tmp/piplus-git-missing-remote-${crypto.randomUUID()}.git`);
    mustGit(repo, 'remote', 'add', 'origin', missingRemote);

    const { app, sessionId } = await seedSession(repo);
    const res = await apiGet(app, sessionId, 'remote-tags');

    // A broken remote must degrade gracefully (page keeps rendering) instead of turning red.
    expect(res.status).toBe(200);
    expect(res.body.remote_ok).toBe(false);
    expect(res.body.remote).toBe('origin');
    expect(res.body.tags).toEqual([]);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);

    await rm(repo, { recursive: true, force: true });
  });

  test('git/tags exposes the object sha of every tag', async () => {
    const repo = await makeRepo('tags-sha');
    const firstSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');
    const annotatedTagSha = mustGit(repo, 'rev-parse', 'refs/tags/v2.0.0');
    const annotatedCommitSha = mustGit(repo, 'rev-parse', 'refs/tags/v2.0.0^{commit}');

    const { app, sessionId } = await seedSession(repo);
    const { status, body } = await apiGet(app, sessionId, 'tags');

    expect(status).toBe(200);
    const lightweight = body.tags.find((t: any) => t.name === 'v1.0.0');
    const annotated = body.tags.find((t: any) => t.name === 'v2.0.0');
    expect(lightweight.sha).toBe(firstSha);
    // Annotated tags expose the tag object sha, which is exactly what `ls-remote` advertises
    // for `refs/tags/<name>` — that equality is what makes the "unpushed" comparison valid.
    expect(annotated.sha).toBe(annotatedTagSha);
    expect(annotated.sha).not.toBe(annotatedCommitSha);
    expect(body.tags.every((t: any) => typeof t.sha === 'string' && t.sha.length === 40)).toBe(true);

    await rm(repo, { recursive: true, force: true });
  });

  test('git/tags keeps the sha correct when a tag subject contains the list separator', async () => {
    const repo = await makeRepo('tags-separator-subject');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    // `|||` is legal in tag messages (and in ref names), so a subject containing it must not
    // shift the fields that follow it — the sha used to be parsed as the subject's tail.
    mustGit(repo, 'tag', '-a', 'v1.0.0', '-m', 'subject with ||| inside');
    const annotatedTagSha = mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0');

    const { app, sessionId } = await seedSession(repo);
    const { status, body } = await apiGet(app, sessionId, 'tags');

    expect(status).toBe(200);
    const tag = body.tags.find((t: any) => t.name === 'v1.0.0');
    expect(tag).toBeDefined();
    expect(tag.name).toBe('v1.0.0');
    expect(tag.is_annotated).toBe(true);
    expect(tag.date).not.toBe('inside');
    // The sha is the tag object sha — never a fragment of the subject.
    expect(tag.sha).toBe(annotatedTagSha);
    expect(tag.sha).toHaveLength(40);
    expect(tag.sha).not.toBe('inside');
    expect(tag.subject).toContain('subject with');

    // User-visible consequence: once pushed, the local sha equals the advertised remote sha, so
    // the Git page no longer shows a permanent false "unpushed" badge for this tag.
    const remote = await makeBareRemote('tags-separator-subject');
    mustGit(repo, 'remote', 'add', 'origin', remote);
    mustGit(repo, 'push', 'origin', 'refs/tags/v1.0.0:refs/tags/v1.0.0');

    const remoteTags = await apiGet(app, sessionId, 'remote-tags');
    expect(remoteTags.status).toBe(200);
    expect(remoteTags.body.tags).toEqual([{ name: 'v1.0.0', sha: annotatedTagSha }]);
    expect(tag.sha).toBe((remoteTags.body.tags as Array<{ sha: string }>)[0].sha);

    // A tag the remote already advertises with the same sha is a no-op, not a re-push.
    const push = await apiPost(app, sessionId, 'tags/push', {});
    expect(push.status).toBe(200);
    expect(push.body.pushed).toEqual([]);

    await rm(repo, { recursive: true, force: true });
  });

  test('git/remote-tags degrades gracefully without a remote and lists the remote once configured', async () => {
    const repo = await makeRepo('remote-tags');
    const firstSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');
    const annotatedTagSha = mustGit(repo, 'rev-parse', 'refs/tags/v2.0.0');
    const remote = await makeBareRemote('remote-tags');

    const { app, sessionId } = await seedSession(repo);

    // No remote configured → graceful 200 so the Git page never turns red.
    const missing = await apiGet(app, sessionId, 'remote-tags');
    expect(missing.status).toBe(200);
    expect(missing.body.session_id).toBe(sessionId);
    expect(missing.body.remote_ok).toBe(false);
    expect(missing.body.remote).toBeNull();
    expect(missing.body.tags).toEqual([]);

    mustGit(repo, 'remote', 'add', 'origin', remote);
    mustGit(repo, 'push', 'origin', 'refs/tags/v1.0.0:refs/tags/v1.0.0', 'refs/tags/v2.0.0:refs/tags/v2.0.0');

    const { status, body } = await apiGet(app, sessionId, 'remote-tags');
    expect(status).toBe(200);
    expect(body.remote_ok).toBe(true);
    expect(body.remote).toBe('origin');
    expect(body.error).toBeNull();
    const remoteTags = body.tags as Array<{ name: string; sha: string }>;
    expect(remoteTags.map((t) => t.name).sort()).toEqual(['v1.0.0', 'v2.0.0']);
    // Annotated tags advertise an extra `refs/tags/<name>^{}` deref line — it must be filtered out.
    expect(remoteTags.every((t) => !t.name.endsWith('^{}'))).toBe(true);
    expect(remoteTags.find((t) => t.name === 'v1.0.0')?.sha).toBe(firstSha);
    expect(remoteTags.find((t) => t.name === 'v2.0.0')?.sha).toBe(annotatedTagSha);

    await rm(repo, { recursive: true, force: true });
  });
});

describe('git tag push', () => {
  test('POST git/tags/push pushes the named tag to the resolved remote', async () => {
    const repo = await makeRepo('tag-push-one');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    const remote = await makeBareRemote('tag-push-one');
    mustGit(repo, 'remote', 'add', 'origin', remote);

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.remote).toBe('origin');
    expect(res.body.pushed).toEqual(['v1.0.0']);
    expect(mustGit(remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(
      mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0'),
    );

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push without names pushes only the tags missing from the remote', async () => {
    const repo = await makeRepo('tag-push-unpushed');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    await commitFile(repo, 'a.txt', 'two', 'second commit');
    mustGit(repo, 'tag', '-a', 'v2.0.0', '-m', 'release 2.0');
    const remote = await makeBareRemote('tag-push-unpushed');
    mustGit(repo, 'remote', 'add', 'origin', remote);

    const { app, sessionId } = await seedSession(repo);

    const first = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });
    expect(first.status).toBe(200);
    expect(first.body.pushed).toEqual(['v1.0.0']);

    // v1.0.0 is already on the remote → only v2.0.0 may be pushed.
    const second = await apiPost(app, sessionId, 'tags/push', {});
    expect(second.status).toBe(200);
    expect(second.body.remote).toBe('origin');
    expect(second.body.pushed).toEqual(['v2.0.0']);
    expect(mustGit(remote, 'rev-parse', 'refs/tags/v2.0.0')).toBe(
      mustGit(repo, 'rev-parse', 'refs/tags/v2.0.0'),
    );

    // Everything is in sync now → no git command runs and the response is an explicit no-op.
    const third = await apiPost(app, sessionId, 'tags/push', {});
    expect(third.status).toBe(200);
    expect(third.body.pushed).toEqual([]);
    expect(third.body.stdout).toBe('Everything up-to-date.');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push refuses to overwrite a conflicting remote tag', async () => {
    const repo = await makeRepo('tag-push-conflict');
    const baseSha = await commitFile(repo, 'a.txt', 'base', 'base commit');
    mustGit(repo, 'tag', 'v1.0.0');
    const remote = await makeBareRemote('tag-push-conflict');
    mustGit(repo, 'remote', 'add', 'origin', remote);
    mustGit(repo, 'push', 'origin', 'refs/tags/v1.0.0:refs/tags/v1.0.0');

    // Move the local tag to a diverging commit → the remote tag must win.
    mustGit(repo, 'checkout', '-b', 'other', baseSha);
    await commitFile(repo, 'a.txt', 'other', 'diverging commit');
    mustGit(repo, 'tag', '-f', 'v1.0.0');
    const localSha = mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0');
    expect(localSha).not.toBe(baseSha);

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(500);
    expect(res.body.result).toBe('error');
    expect(res.body.remote).toBe('origin');
    expect(res.body.error.code).toBe('TAG_PUSH_FAILED');
    expect(res.body.pushed).toEqual([]);
    // No --force: the remote tag still points at the original commit.
    expect(mustGit(remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(baseSha);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push accepts a remote whose name looks like a git option', async () => {
    const repo = await makeRepo('tag-push-option-remote');
    const baseSha = await commitFile(repo, 'a.txt', 'base', 'base commit');
    mustGit(repo, 'tag', 'v1.0.0');
    const remote = await makeBareRemote('tag-push-option-remote');
    // A remote literally named `--force`: without `--` git parses it as a flag, so the first
    // refspec would be mistaken for the repository and the push would fail.
    mustGit(repo, 'remote', 'add', '--', '--force', remote);

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.remote).toBe('--force');
    expect(res.body.pushed).toEqual(['v1.0.0']);
    expect(mustGit(remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(
      mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0'),
    );

    // The same odd name must also survive `git ls-remote --tags -- <remote>`.
    const remoteTags = await apiGet(app, sessionId, 'remote-tags');
    expect(remoteTags.status).toBe(200);
    expect(remoteTags.body.remote_ok).toBe(true);
    expect(remoteTags.body.tags.map((t: { name: string }) => t.name)).toEqual(['v1.0.0']);

    // Moving the local tag to a diverging commit still must not overwrite the remote tag.
    mustGit(repo, 'checkout', '-b', 'other', baseSha);
    await commitFile(repo, 'a.txt', 'other', 'diverging commit');
    mustGit(repo, 'tag', '-f', 'v1.0.0');
    const conflict = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });
    expect(conflict.status).toBe(500);
    expect(conflict.body.error.code).toBe('TAG_PUSH_FAILED');
    expect(mustGit(remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(baseSha);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push deduplicates names and rejects a non-array names value', async () => {
    const repo = await makeRepo('tag-push-names-shape');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    mustGit(repo, 'tag', 'v2.0.0');
    const remote = await makeBareRemote('tag-push-names-shape');
    mustGit(repo, 'remote', 'add', 'origin', remote);

    const { app, sessionId } = await seedSession(repo);

    // A malformed `names` must not silently expand to "push every unpushed tag".
    const malformed = await apiPost(app, sessionId, 'tags/push', { names: 'v1.0.0' });
    expect(malformed.status).toBe(400);
    expect(malformed.body.error.code).toBe('INVALID_NAMES');
    expect(mustGit(remote, 'tag', '-l')).toBe('');

    // A non-string scalar must not be coerced (String(1234)) into a bogus ref and fail as a 500.
    const numeric = await apiPost(app, sessionId, 'tags/push', { names: [1234] });
    expect(numeric.status).toBe(400);
    expect(numeric.body.error.code).toBe('INVALID_NAMES');
    expect(mustGit(remote, 'tag', '-l')).toBe('');

    // Duplicates collapse into a single refspec — git rejects the same ref pushed twice.
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0', 'v1.0.0'] });
    expect(res.status).toBe(200);
    expect(res.body.pushed).toEqual(['v1.0.0']);
    expect(mustGit(remote, 'tag', '-l')).toBe('v1.0.0');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/push pushes the branch with a configured token (argv form)', async () => {
    const repo = await makeRepo('push-branch-with-token');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    const remote = await makeBareRemote('push-branch-with-token');
    mustGit(repo, 'remote', 'add', 'origin', remote);
    mustGit(repo, 'push', '-u', 'origin', 'main');
    const headSha = await commitFile(repo, 'a.txt', 'two', 'second commit');

    // Covers the rewritten `git/push` route including its `http.extraheader` token option.
    const { app, sessionId } = await seedSession(repo, {
      userName: 'Push User',
      userEmail: 'push@example.com',
      token: 'push-token',
    });
    const res = await apiPost(app, sessionId, 'push', {});

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(mustGit(remote, 'rev-parse', 'refs/heads/main')).toBe(headSha);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push returns NO_REMOTE when the repository has no remote', async () => {
    const repo = await makeRepo('tag-push-no-remote');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_REMOTE');
    expect(res.body.error.message).toBe('No git remote is configured');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push pushes with a configured token (token branch, argv form)', async () => {
    const repo = await makeRepo('tag-push-token');
    await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    const remote = await makeBareRemote('tag-push-token');
    mustGit(repo, 'remote', 'add', 'origin', remote);

    const metachar = trackTempPath(`/tmp/piplus-git-token-metachar-${crypto.randomUUID()}`);
    // The token reaches git as `-c http.extraheader=AUTHORIZATION: Basic <base64>`. base64
    // neutralises the metacharacters, so this test proves the token branch runs end to end
    // (rather than being skipped) and that the value is assembled without shell quoting.
    const token = `tok$(touch ${metachar})\`whoami\``;
    const { app, sessionId } = await seedSession(repo, {
      userName: 'Token User',
      userEmail: 'token@example.com',
      token,
    });

    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(res.body.pushed).toEqual(['v1.0.0']);
    expect(await Bun.file(metachar).exists()).toBe(false);
    expect(mustGit(remote, 'rev-parse', 'refs/tags/v1.0.0')).toBe(
      mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0'),
    );

    await rm(repo, { recursive: true, force: true });
  });
});

describe('git push remote resolution priority', () => {
  test('POST git/tags/push prefers remote.pushDefault over branch.<name>.remote', async () => {
    const { repo, remotes } = await makeRepoWithRemotes('push-remote-priority-a', ['r1', 'r2']);
    const tagSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    // `git push` resolves remote.pushDefault before branch.<name>.remote.
    mustGit(repo, 'config', 'branch.main.remote', 'r1');
    mustGit(repo, 'config', 'remote.pushDefault', 'r2');

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.remote).toBe('r2');
    // The tag must really land in r2 — a wrong return value here pushes to the wrong repo.
    expect(mustGit(remotes.r2, 'rev-parse', 'refs/tags/v1.0.0')).toBe(tagSha);
    expect(mustGit(remotes.r1, 'tag', '-l')).toBe('');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push prefers branch.<name>.pushRemote over pushDefault and branch.remote', async () => {
    const { repo, remotes } = await makeRepoWithRemotes('push-remote-priority-b', ['r1', 'r2', 'r3']);
    const tagSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    mustGit(repo, 'config', 'branch.main.remote', 'r1');
    mustGit(repo, 'config', 'remote.pushDefault', 'r2');
    // pushRemote is the first source git consults for a branch-specific push.
    mustGit(repo, 'config', 'branch.main.pushRemote', 'r3');

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.remote).toBe('r3');
    expect(mustGit(remotes.r3, 'rev-parse', 'refs/tags/v1.0.0')).toBe(tagSha);
    expect(mustGit(remotes.r1, 'tag', '-l')).toBe('');
    expect(mustGit(remotes.r2, 'tag', '-l')).toBe('');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push falls back to branch.<name>.remote when no push remote is set', async () => {
    const { repo, remotes } = await makeRepoWithRemotes('push-remote-priority-c', ['r1', 'r2']);
    const tagSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    mustGit(repo, 'config', 'branch.main.remote', 'r1');

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.remote).toBe('r1');
    expect(mustGit(remotes.r1, 'rev-parse', 'refs/tags/v1.0.0')).toBe(tagSha);
    expect(mustGit(remotes.r2, 'tag', '-l')).toBe('');

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push falls back to the first configured remote without branch config', async () => {
    const { repo, remotes } = await makeRepoWithRemotes('push-remote-priority-d', ['r1', 'r2']);
    const tagSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    // No branch.* config: the helper keeps its documented fallback, `git remote`'s first entry
    // (git sorts the names). git itself would refuse to push without an explicit destination,
    // but the API still has to pick exactly one remote for tag listing and pushing.
    const firstRemote = mustGit(repo, 'remote').split('\n').map((line) => line.trim()).filter(Boolean)[0];
    expect(firstRemote).toBeTruthy();

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(res.status).toBe(200);
    expect(res.body.remote).toBe(firstRemote);
    expect(mustGit(remotes[firstRemote], 'rev-parse', 'refs/tags/v1.0.0')).toBe(tagSha);
    for (const [name, dir] of Object.entries(remotes)) {
      if (name === firstRemote) continue;
      expect(mustGit(dir, 'tag', '-l')).toBe('');
    }

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/tags/push skips branch.<name>.* on a detached HEAD but keeps pushDefault', async () => {
    const { repo, remotes } = await makeRepoWithRemotes('push-remote-priority-detached', ['r1', 'r2']);
    const baseSha = await commitFile(repo, 'a.txt', 'one', 'first commit');
    mustGit(repo, 'tag', 'v1.0.0');
    // Only branch-scoped config, and it would outrank the plain first-remote fallback. On a
    // detached HEAD this config is unreachable, so landing on r1 proves it was really skipped.
    mustGit(repo, 'config', 'branch.main.remote', 'r2');
    mustGit(repo, 'config', 'branch.main.pushRemote', 'r2');
    // Literal `branch.HEAD.*` is the trap for a naive fallback that just reads
    // `branch.<rev-parse --abbrev-ref HEAD>.*`: while detached that yields the string `HEAD`,
    // so a missing guard would silently honour this key. Without this line the test below
    // would pass either way and would not actually pin the detached-HEAD guard.
    mustGit(repo, 'config', 'branch.HEAD.remote', 'r2');
    mustGit(repo, 'config', 'branch.HEAD.pushRemote', 'r2');
    mustGit(repo, 'checkout', '--detach', baseSha);

    const { app, sessionId } = await seedSession(repo);
    const first = await apiPost(app, sessionId, 'tags/push', { names: ['v1.0.0'] });

    expect(first.status).toBe(200);
    // Discriminating assertion: branch.main.pushRemote=r2 is set, so if the branch-scoped
    // lookup were still reachable while detached the push would land in r2 instead of r1.
    expect(first.body.remote).toBe('r1');
    expect(mustGit(remotes.r1, 'rev-parse', 'refs/tags/v1.0.0')).toBe(
      mustGit(repo, 'rev-parse', 'refs/tags/v1.0.0'),
    );
    expect(mustGit(remotes.r2, 'tag', '-l')).toBe('');

    // remote.pushDefault is not branch-scoped, so it still applies while detached.
    mustGit(repo, 'tag', 'v2.0.0');
    mustGit(repo, 'config', 'remote.pushDefault', 'r2');
    const second = await apiPost(app, sessionId, 'tags/push', { names: ['v2.0.0'] });
    expect(second.status).toBe(200);
    expect(second.body.remote).toBe('r2');
    expect(mustGit(remotes.r2, 'rev-parse', 'refs/tags/v2.0.0')).toBe(
      mustGit(repo, 'rev-parse', 'refs/tags/v2.0.0'),
    );

    await rm(repo, { recursive: true, force: true });
  });
});

describe('git commit and push shell-injection regression', () => {
  test('POST git/commit keeps shell metacharacters in the message without executing them', async () => {
    const repo = await makeRepo('commit-injection');
    await Bun.write(path.join(repo, 'a.txt'), 'one');
    const dollarPwned = trackTempPath(`/tmp/piplus-git-commit-dollar-${crypto.randomUUID()}`);
    const backtickPwned = trackTempPath(`/tmp/piplus-git-commit-backtick-${crypto.randomUUID()}`);
    const message = `fix $(touch ${dollarPwned}) \`touch ${backtickPwned}\` "quoted" $$HOME`;

    const { app, sessionId } = await seedSession(repo);
    const res = await apiPost(app, sessionId, 'commit', { message });

    expect(res.status).toBe(200);
    expect(res.body.result).toBe('ok');
    expect(await Bun.file(dollarPwned).exists()).toBe(false);
    expect(await Bun.file(backtickPwned).exists()).toBe(false);
    // The message must be stored byte-for-byte, not shell-expanded.
    expect(mustGit(repo, 'log', '-1', '--format=%B')).toBe(message);

    await rm(repo, { recursive: true, force: true });
  });

  test('POST git/commit keeps the configured user identity without shell interpolation', async () => {
    const repo = await makeRepo('commit-identity');
    await Bun.write(path.join(repo, 'a.txt'), 'one');
    const userName = 'A "B" $(whoami)';
    const userEmail = 'user@example.com';

    const { app, sessionId } = await seedSession(repo, { userName, userEmail });
    const res = await apiPost(app, sessionId, 'commit', { message: 'identity commit' });

    expect(res.status).toBe(200);
    expect(mustGit(repo, 'log', '-1', '--format=%an')).toBe(userName);
    expect(mustGit(repo, 'log', '-1', '--format=%ae')).toBe(userEmail);

    await rm(repo, { recursive: true, force: true });
  });
});
