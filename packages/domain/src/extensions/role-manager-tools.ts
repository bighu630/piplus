import type { PiToolDef } from '@piplus/pi-client';
import type { PiClient } from '@piplus/pi-client';
import type { RoleCatalog } from './role-catalog';
import type { RoleManagerDb } from '../role-manager/service';
import { sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { createRoleManagerService } from '../role-manager/service';
import { startSessionRun } from '../session/runtime';

function labelForRole(key: string) {
  const map: Record<string, string> = {
    planner: '规划者', worker: '执行者', reviewer: '审查者', researcher: '研究者', blank: '空白',
  };
  return map[key] ?? key;
}

export function buildRoleManagerToolDefs(catalog: RoleCatalog): PiToolDef[] {
  const roleLines = catalog.roles
    .map((r) => `- ${r.key}: ${r.description}`)
    .join('\n');

  return [
    {
      name: 'spawn_session',
      description: [
        'Create a child session with a specialized role to delegate work.',
        '',
        'Available roles right now:',
        roleLines,
        '',
        'The platform will create the child session, assemble the role prompt,',
        'and track parent/child session relationships automatically.',
      ].join('\n'),
      parameters: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Role key (must be one of the available roles listed above)' },
          objective: { type: 'string', description: 'The outcome this child session should achieve' },
          scope: { type: 'string', description: 'The codebase area or boundary it should stay within (optional)' },
          task: { type: 'string', description: 'The specific task to execute (optional)' },
          constraints: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional extra restrictions',
          },
        },
        required: ['role', 'objective'],
      },
    },
    {
      name: 'writeback_to_parent',
      description:
        'Write results back to the parent session when work is complete. The platform resolves the parent internally.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary of work completed' },
          blocks: {
            type: 'array',
            items: { type: 'object' },
            description: 'Optional structured output blocks',
          },
        },
        required: ['summary'],
      },
    },
  ];
}

export type RoleManagerToolContext = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
};

export async function invokeRoleManagerTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: RoleManagerToolContext,
): Promise<unknown> {
  const roleManager = createRoleManagerService(ctx.db, ctx.piClient);

  if (toolName === 'spawn_session') {
    const [parent] = await ctx.db
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, ctx.sessionId))
      .limit(1);
    if (!parent) throw new Error('parent_session_not_found');

    const result = await roleManager.spawnSession({
      projectId: parent.projectId,
      parentSessionId: ctx.sessionId,
      createdBy: ctx.userId,
      role: String(args.role ?? 'worker'),
      objective: String(args.objective ?? ''),
      scope: args.scope ? String(args.scope) : undefined,
      task: args.task ? String(args.task) : undefined,
      constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    });


    // 后台异步启动子 session
    const kickOffMsg = `请开始执行你的任务。目标：${String(args.objective ?? '')}。范围：${args.scope ? String(args.scope) : '无限制'}。具体任务：${args.task ? String(args.task) : String(args.objective ?? '')}`;
    console.log('[role-manager-tools] kickoff start', { sessionId: result.sessionId, locatorFile: result.locator.sessionFile, kickOffMsg });
    void startSessionRun({
      db: ctx.db,
      piClient: ctx.piClient,
      sessionId: result.sessionId,
      userId: ctx.userId,
      content: kickOffMsg,
    })
      .then((run) => {
        console.log('[role-manager-tools] kickoff message sent', { runId: run.runId });
      })
      .catch((err) => {
        console.error('[role-manager-tools] kickoff failed', err?.message ?? err);
      });

    return {
      status: 'created',
      message: `已创建 ${labelForRole(String(args.role))} 子会话（点击左侧栏可切换）`,
    };
  }

  if (toolName === 'writeback_to_parent') {
    await roleManager.writebackToParent({
      childSessionId: ctx.sessionId,
      summary: String(args.summary ?? ''),
      blocks: Array.isArray(args.blocks) ? args.blocks : null,
    });
    return { ok: true };
  }

  throw new Error(`unknown_tool:${toolName}`);
}
