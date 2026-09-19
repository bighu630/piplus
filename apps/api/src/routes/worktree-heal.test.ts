import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { createSeedDb } from '@piplus/db/init';
import { createDb } from '@piplus/db/client';
import { sessions } from '@piplus/db/schema';
import { createApp } from '../app';

// 会话的 worktree_path 指向已被外部清理的目录时的行为。
//
// 背景：Bun 的 execSync 在 cwd 不存在时报的是 `ENOENT ... posix_spawn '/bin/sh'`，
// 极易被误判为「缺少 shell」。因此 resolveProjectDir 必须显式检测目录存在性。
//
// 语义（用户确认的方案）：读时回落 + 每次如实回报，**不在 GET 上清库** ——
// existsSync 对「祖先目录不可访问」也会返回 false，读时清空会永久删掉暂时不可用的有效关联；
// 清空交给既有显式路径（git/checkout 切到普通分支时清空、切到 worktree 分支时写回）。

function makeDbPath() {
  return `/tmp/piplus-worktree-heal-${crypto.randomUUID()}.sqlite`;
}

function makeDir(label: string) {
  return `/tmp/piplus-worktree-heal-${label}-${crypto.randomUUID()}`;
}

/** 建一个最小但真实的 git 仓库：git/branches 等路由在非仓库目录下会因别的原因失败。 */
function initGitRepo(dir: string) {
  spawnSync('git', ['init', '-q'], { cwd: dir });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'init', '-q'], { cwd: dir });
}

type Ctx = {
  app: ReturnType<typeof createApp>;
  db: ReturnType<typeof createDb>;
  sessionId: string;
  projectDir: string;
  missingWorktree: string;
  cleanup: () => Promise<void>;
};

async function setup(): Promise<Ctx> {
  const dbPath = makeDbPath();
  const projectDir = makeDir('project');
  const originalDbUrl = Bun.env.DATABASE_URL;

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
  const missingWorktree = makeDir('gone-worktree');
  const db = createDb(`file:${dbPath}`);
  db.update(sessions).set({ worktreePath: missingWorktree }).where(eq(sessions.id, sessionId)).run();

  return {
    app, db, sessionId, projectDir, missingWorktree,
    cleanup: async () => {
      if (originalDbUrl === undefined) delete Bun.env.DATABASE_URL;
      else Bun.env.DATABASE_URL = originalDbUrl;
      await rm(projectDir, { recursive: true, force: true });
    },
  };
}

const authHeaders = { 'x-user-id': 'user_seed' };

describe('失效 worktree：读时回落 + 持续回报', () => {
  test('文件树回落到项目根、回报原路径，且不清空会话上的关联（可逆）', async () => {
    const ctx = await setup();
    try {
      await writeFile(path.join(ctx.projectDir, 'hello.txt'), 'hi', 'utf8');

      const res = await ctx.app.request(`/api/v1/sessions/${ctx.sessionId}/files/tree`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.root_path).toBe(ctx.projectDir);
      expect(body.missing_worktree_path).toBe(ctx.missingWorktree);
      expect(body.tree.some((n: { name: string }) => n.name === 'hello.txt')).toBe(true);

      // 关联仍在库里：读时不写库，worktree 目录若恢复则自动重新生效
      const [row] = ctx.db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)).limit(1).all();
      expect(row.worktreePath).toBe(ctx.missingWorktree);

      // 第二次请求仍然如实回报（提示常驻，不会因为谁先请求而被"消费"掉）
      const again = await ctx.app.request(`/api/v1/sessions/${ctx.sessionId}/files/tree`, { headers: authHeaders });
      const againBody = await again.json();
      expect(againBody.missing_worktree_path).toBe(ctx.missingWorktree);
      expect(againBody.root_path).toBe(ctx.projectDir);
    } finally {
      await ctx.cleanup();
    }
  });

  test('files/content 也带该字段', async () => {
    const ctx = await setup();
    try {
      await writeFile(path.join(ctx.projectDir, 'a.txt'), 'content', 'utf8');
      const res = await ctx.app.request(
        `/api/v1/sessions/${ctx.sessionId}/files/content?path=a.txt`,
        { headers: authHeaders },
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.missing_worktree_path).toBe(ctx.missingWorktree);
    } finally {
      await ctx.cleanup();
    }
  });

  test('git/branches：不再返回 GIT_ERROR / posix_spawn（用户实际遇到的报错）', async () => {
    const ctx = await setup();
    try {
      const res = await ctx.app.request(`/api/v1/sessions/${ctx.sessionId}/git/branches`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBeUndefined();
      expect(body.cwd).toBe(ctx.projectDir);
      expect(body.missing_worktree_path).toBe(ctx.missingWorktree);
      // 已回退，所以不再把它当成会话的 worktree
      expect(body.session_worktree_path).toBeNull();
    } finally {
      await ctx.cleanup();
    }
  });

  test('git-diff：同样回落到项目根并带上提示字段', async () => {
    const ctx = await setup();
    try {
      const res = await ctx.app.request(`/api/v1/sessions/${ctx.sessionId}/git-diff`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.cwd).toBe(ctx.projectDir);
      expect(body.missing_worktree_path).toBe(ctx.missingWorktree);
    } finally {
      await ctx.cleanup();
    }
  });

  test('worktree 目录存在时不触发回落，且用该目录作为根（对照组）', async () => {
    const ctx = await setup();
    const realWorktree = makeDir('real-worktree');
    try {
      await mkdir(realWorktree, { recursive: true });
      ctx.db.update(sessions).set({ worktreePath: realWorktree }).where(eq(sessions.id, ctx.sessionId)).run();

      const res = await ctx.app.request(`/api/v1/sessions/${ctx.sessionId}/files/tree`, { headers: authHeaders });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.missing_worktree_path).toBeNull();
      // 关键：根是 worktree 本身，而不是项目根，才能证明 cwd 选择逻辑正确
      expect(body.root_path).toBe(realWorktree);

      const [row] = ctx.db.select().from(sessions).where(eq(sessions.id, ctx.sessionId)).limit(1).all();
      expect(row.worktreePath).toBe(realWorktree);
    } finally {
      await rm(realWorktree, { recursive: true, force: true });
      await ctx.cleanup();
    }
  });

  test('项目根也不存在时给出明确错误，而不是误导性的 shell 报错', async () => {
    const ctx = await setup();
    try {
      // 清掉 worktree 关联，让 cwd 直接用项目根，再把项目根删掉
      ctx.db.update(sessions).set({ worktreePath: null }).where(eq(sessions.id, ctx.sessionId)).run();
      await rm(ctx.projectDir, { recursive: true, force: true });

      const res = await ctx.app.request(`/api/v1/sessions/${ctx.sessionId}/files/tree`, { headers: authHeaders });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('PROJECT_DIR_MISSING');
      expect(body.error.message).toContain(ctx.projectDir);
      expect(JSON.stringify(body)).not.toContain('posix_spawn');
    } finally {
      await ctx.cleanup();
    }
  });
});
