import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createSeedDb } from '@piplus/db/init';
import { createDb } from '@piplus/db/client';
import { sessions } from '@piplus/db/schema';
import { createApp } from '../app';

// 会话的 worktree_path 指向已被外部清理的目录时的自愈行为。
//
// 背景：Bun 的 execSync 在 cwd 不存在时报的是 `ENOENT ... posix_spawn '/bin/sh'`，
// 极易被误判为「缺少 shell」。因此 resolveProjectDir 必须显式检测目录存在性：
// 回落到项目根、清除会话上的关联，并把原路径回报给前端做提示。

function makeDbPath() {
  return `/tmp/piplus-worktree-heal-${crypto.randomUUID()}.sqlite`;
}

function makeProjectDir() {
  return `/tmp/piplus-worktree-heal-project-${crypto.randomUUID()}`;
}

/** 建一个最小但真实的 git 仓库：git/branches 等路由在非仓库目录下会因别的原因失败。 */
function initGitRepo(dir: string) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '-q'], { cwd: dir });
}

async function setup() {
  const dbPath = makeDbPath();
  const projectDir = makeProjectDir();
  createSeedDb(dbPath);
  await mkdir(projectDir, { recursive: true });
  initGitRepo(projectDir);
  Bun.env.DATABASE_URL = `file:${dbPath}`;
  const app = createApp();

  const projectRes = await app.request('/api/v1/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
    body: JSON.stringify({ name: 'Worktree Heal Project', mode: 'existing', path: projectDir }),
  });
  expect(projectRes.status).toBe(201);
  const { sessionId } = (await projectRes.json()) as { sessionId: string };

  // 把会话指向一个不存在的 worktree（模拟 worktree 被 rm -rf / git worktree prune 清理）
  const missingWorktree = `/tmp/piplus-gone-worktree-${crypto.randomUUID()}`;
  const db = createDb(`file:${dbPath}`);
  db.update(sessions).set({ worktreePath: missingWorktree }).where(eq(sessions.id, sessionId)).run();

  return { app, db, sessionId, projectDir, missingWorktree };
}

const authHeaders = { 'x-user-id': 'user_seed' };

describe('失效 worktree 的自愈回落', () => {
  test('文件树：回落到项目根、回报 missing_worktree_path、并清除会话关联', async () => {
    const { app, db, sessionId, projectDir, missingWorktree } = await setup();
    await writeFile(path.join(projectDir, 'hello.txt'), 'hi', 'utf8');

    const res = await app.request(`/api/v1/sessions/${sessionId}/files/tree`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.root_path).toBe(projectDir);
    expect(body.missing_worktree_path).toBe(missingWorktree);
    expect(body.tree.some((n: { name: string }) => n.name === 'hello.txt')).toBe(true);

    // 关联已落库清除
    const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
    expect(row.worktreePath).toBeNull();

    // 第二次请求不再报告（自愈只发生一次），且工作目录仍是项目根
    const again = await app.request(`/api/v1/sessions/${sessionId}/files/tree`, { headers: authHeaders });
    const againBody = await again.json();
    expect(againBody.missing_worktree_path).toBeNull();
    expect(againBody.root_path).toBe(projectDir);

    await rm(projectDir, { recursive: true, force: true });
  });

  test('git/branches：不再返回 GIT_ERROR / posix_spawn（用户实际遇到的报错）', async () => {
    const { app, sessionId, projectDir, missingWorktree } = await setup();

    const res = await app.request(`/api/v1/sessions/${sessionId}/git/branches`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.cwd).toBe(projectDir);
    expect(body.missing_worktree_path).toBe(missingWorktree);
    // 已回退，所以不再把它当成会话的 worktree
    expect(body.session_worktree_path).toBeNull();

    await rm(projectDir, { recursive: true, force: true });
  });

  test('git-diff：同样回落到项目根并带上提示字段', async () => {
    const { app, sessionId, projectDir, missingWorktree } = await setup();

    const res = await app.request(`/api/v1/sessions/${sessionId}/git-diff`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.cwd).toBe(projectDir);
    expect(body.missing_worktree_path).toBe(missingWorktree);

    await rm(projectDir, { recursive: true, force: true });
  });

  test('worktree 目录存在时不触发回落（对照组）', async () => {
    const { app, db, sessionId, projectDir } = await setup();
    // 指向一个真实存在的目录
    db.update(sessions).set({ worktreePath: projectDir }).where(eq(sessions.id, sessionId)).run();

    const res = await app.request(`/api/v1/sessions/${sessionId}/files/tree`, { headers: authHeaders });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.missing_worktree_path).toBeNull();
    expect(body.root_path).toBe(projectDir);

    const [row] = db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1).all();
    expect(row.worktreePath).toBe(projectDir);

    await rm(projectDir, { recursive: true, force: true });
  });
});
