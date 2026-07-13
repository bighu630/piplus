import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { roleTemplates } from '@piplus/db/schema';
import { eq, and, isNull } from 'drizzle-orm';
import { getDbPath } from '../db-context';

export function registerRoleTemplateRoutes(app: Hono) {
  
  // 列出所有角色模板（非归档的）
  app.get('/api/v1/role-templates', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const rows = await db
      .select({
        id: roleTemplates.id,
        key: roleTemplates.key,
        version: roleTemplates.version,
        name: roleTemplates.name,
        description: roleTemplates.description,
        basePrompt: roleTemplates.basePrompt,
        configJson: roleTemplates.configJson,
        isBuiltin: roleTemplates.isBuiltin,
        createdAt: roleTemplates.createdAt,
        updatedAt: roleTemplates.updatedAt,
      })
      .from(roleTemplates)
      .where(isNull(roleTemplates.archivedAt))
      .orderBy(roleTemplates.key, roleTemplates.version);
    
    return c.json(rows.map(r => {
      let icon: string | null = null;
      try {
        const parsed = JSON.parse(r.configJson ?? '{}');
        if (parsed.icon && typeof parsed.icon === 'string') icon = parsed.icon;
      } catch {}
      return {
        id: r.id,
        key: r.key,
        version: r.version,
        name: r.name,
        description: r.description,
        basePrompt: r.basePrompt,
        icon,
        isBuiltin: r.isBuiltin,
        created_at: new Date(r.createdAt).toISOString(),
        updated_at: new Date(r.updatedAt).toISOString(),
      };
    }));
  });

  // 获取单个角色模板详情
  app.get('/api/v1/role-templates/:id', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const id = c.req.param('id');
    const [row] = await db
      .select()
      .from(roleTemplates)
      .where(and(eq(roleTemplates.id, id), isNull(roleTemplates.archivedAt)))
      .limit(1);
    if (!row) return c.json({ error: { code: 'NOT_FOUND', message: 'Role template not found' } }, 404);
    let icon: string | null = null;
    try {
      const parsed = JSON.parse(row.configJson ?? '{}');
      if (parsed.icon && typeof parsed.icon === 'string') icon = parsed.icon;
    } catch {}
    return c.json({
      ...row,
      icon,
      created_at: new Date(row.createdAt).toISOString(),
      updated_at: new Date(row.updatedAt).toISOString(),
    });
  });

  // 创建新角色模板
  app.post('/api/v1/role-templates', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const body = await c.req.json().catch(() => ({}));
    const { key, version, basePrompt, name, description, icon } = body as any;
    
    if (!key || !version) {
      return c.json({ error: { code: 'VALIDATION_ERROR', message: 'key and version are required' } }, 400);
    }

    // Check for duplicate (key, version)
    const [existing] = await db
      .select({ id: roleTemplates.id })
      .from(roleTemplates)
      .where(and(eq(roleTemplates.key, key), eq(roleTemplates.version, version), isNull(roleTemplates.archivedAt)))
      .limit(1);
    if (existing) {
      return c.json({ error: { code: 'CONFLICT', message: `Role template '${key}' version '${version}' already exists` } }, 409);
    }

    const now = new Date();
    const id = `role_${crypto.randomUUID().slice(0, 12)}`;
    
    await db.insert(roleTemplates).values({
      id,
      key,
      version,
      name: name || key,
      description: description || '',
      basePrompt: basePrompt || '',
      configJson: icon ? JSON.stringify({ icon }) : '{}',
      createdBy: userId,
      ownerType: 'user',
      visibility: 'public',
      isBuiltin: false,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    } as any);

    const [created] = await db.select().from(roleTemplates).where(eq(roleTemplates.id, id)).limit(1);
    return c.json(created, 201);
  });

  // 更新角色模板
  app.put('/api/v1/role-templates/:id', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    
    const [existing] = await db.select().from(roleTemplates).where(eq(roleTemplates.id, id)).limit(1);
    if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Role template not found' } }, 404);
    if (existing.isBuiltin) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot modify built-in role templates' } }, 403);
    }

    const updates: Record<string, any> = { updatedAt: new Date() };
    if (body.basePrompt !== undefined) updates.basePrompt = body.basePrompt;
    if (body.name !== undefined) updates.name = body.name;
    if (body.description !== undefined) updates.description = body.description;
    if (body.visibility !== undefined) updates.visibility = body.visibility;

    // Handle icon update — merge into configJson
    if (body.icon !== undefined) {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(existing.configJson ?? '{}');
      } catch {}
      config.icon = body.icon;
      updates.configJson = JSON.stringify(config);
    }

    await db.update(roleTemplates).set(updates).where(eq(roleTemplates.id, id));
    
    const [updated] = await db.select().from(roleTemplates).where(eq(roleTemplates.id, id)).limit(1);
    return c.json(updated);
  });

  // 删除角色模板（仅非内置）
  app.delete('/api/v1/role-templates/:id', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const id = c.req.param('id');
    
    const [existing] = await db.select().from(roleTemplates).where(eq(roleTemplates.id, id)).limit(1);
    if (!existing) return c.json({ error: { code: 'NOT_FOUND', message: 'Role template not found' } }, 404);
    if (existing.isBuiltin) {
      return c.json({ error: { code: 'FORBIDDEN', message: 'Cannot delete built-in role templates' } }, 403);
    }

    // Soft delete (archive)
    await db.update(roleTemplates).set({ archivedAt: new Date(), updatedAt: new Date() }).where(eq(roleTemplates.id, id));
    return c.json({ ok: true });
  });
}
