import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { projects, roleTemplates, sessions } from '@piplus/db/schema';
import { and, desc, eq } from 'drizzle-orm';
import { getDbPath } from '../db-context';

type TreeNode = {
  id: string;
  project_id: string;
  parent_session_id: string | null;
  root_session_id: string;
  depth: number;
  role_template_key: string;
  title: string;
  status: string;
  runtime_status: string;
  archived_at: string | null;
  pinned_at: string | null;
  last_activity_at: string;
  children: TreeNode[];
};

export function registerTreeRoutes(app: Hono) {
  /**
   * @swagger
   * /api/v1/tree:
   *   get:
   *     summary: 获取项目树与会话树
   *     tags: [Tree]
   *     security:
   *       - bearerAuth: []
   *     description: 返回当前用户的项目列表，以及每个项目下按层级组织的会话树。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       401:
   *         description: 未认证。
   */
  app.get('/api/v1/tree', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const projectRows = await db.select().from(projects).where(eq(projects.createdBy, userId)).orderBy(desc(projects.lastActivityAt));

    const result = await Promise.all(
      projectRows.map(async (project) => {
        const sessionRows = await db
          .select({
            id: sessions.id,
            projectId: sessions.projectId,
            parentSessionId: sessions.parentSessionId,
            rootSessionId: sessions.rootSessionId,
            depth: sessions.depth,
            title: sessions.title,
            status: sessions.status,
            runtimeStatus: sessions.runtimeStatus,
            archivedAt: sessions.archivedAt,
            pinnedAt: sessions.pinnedAt,
            lastActivityAt: sessions.lastActivityAt,
            roleTemplateId: sessions.roleTemplateId,
          })
          .from(sessions)
          .where(eq(sessions.projectId, project.id))
          .orderBy(desc(sessions.lastActivityAt));

        const roleKeys = new Map<string, string>();
        for (const s of sessionRows) {
          if (!roleKeys.has(s.roleTemplateId)) {
            const [rt] = await db.select({ key: roleTemplates.key }).from(roleTemplates).where(eq(roleTemplates.id, s.roleTemplateId)).limit(1);
            if (rt) roleKeys.set(s.roleTemplateId, rt.key);
          }
        }

        const childrenMap = new Map<string | null, TreeNode[]>();

        for (const s of sessionRows) {
          const node: TreeNode = {
            id: s.id,
            project_id: s.projectId,
            parent_session_id: s.parentSessionId,
            root_session_id: s.rootSessionId,
            depth: s.depth,
            role_template_key: roleKeys.get(s.roleTemplateId) ?? 'unknown',
            title: s.title,
            status: s.status,
            runtime_status: s.runtimeStatus,
            archived_at: s.archivedAt ? new Date(s.archivedAt).toISOString() : null,
            pinned_at: s.pinnedAt ? new Date(s.pinnedAt).toISOString() : null,
            last_activity_at: new Date(s.lastActivityAt).toISOString(),
            children: [],
          };
          const parentKey = s.parentSessionId ?? null;
          const siblings = childrenMap.get(parentKey) ?? [];
          siblings.push(node);
          childrenMap.set(parentKey, siblings);
        }

        const buildTree = (parentId: string | null): TreeNode[] => {
          const nodes = (childrenMap.get(parentId) ?? []).map((node) => ({
            ...node,
            children: buildTree(node.id),
          }));
          // Sort: pinned first (newer pinned first), then by last_activity_at desc
          nodes.sort((a, b) => {
            if (a.pinned_at && !b.pinned_at) return -1;
            if (!a.pinned_at && b.pinned_at) return 1;
            if (a.pinned_at && b.pinned_at) return a.pinned_at < b.pinned_at ? 1 : a.pinned_at > b.pinned_at ? -1 : 0;
            return new Date(b.last_activity_at).getTime() - new Date(a.last_activity_at).getTime();
          });
          return nodes;
        };

        return {
          id: project.id,
          name: project.name,
          status: project.status,
          archived_at: project.archivedAt ? new Date(project.archivedAt).toISOString() : null,
          last_activity_at: new Date(project.lastActivityAt).toISOString(),
          created_at: new Date(project.createdAt).toISOString(),
          role_default_models: (() => { try { return JSON.parse(project.roleDefaultModels ?? '{}'); } catch { return {}; } })(),
          sessions: buildTree(null),
        };
      }),
    );

    return c.json({ projects: result });
  });
}
