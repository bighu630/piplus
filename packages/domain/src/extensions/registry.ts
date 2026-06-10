import type { PiClient, PiToolDef } from '@piplus/pi-client';
import type { RoleManagerDb } from '../role-manager/service';
import { sessions } from '@piplus/db/schema';
import { eq } from 'drizzle-orm';
import { createRoleManagerService } from '../role-manager/service';
import { buildSpawnSessionInput } from './spawn-session';
import { buildWritebackToParentInput } from './writeback-to-parent';

export function buildPlatformToolDefs(): PiToolDef[] {
  return [
    {
      name: 'spawn_session',
      description:
        'Spawn a child session with a specific role. The child session will have its own context and PI session. Parent/child relationships and writeback targets are resolved by the platform internally.',
      parameters: {
        role: { type: 'string', description: 'Role key for the child session (e.g., worker, reviewer)' },
        target: { type: 'string', description: 'Concrete target description for the child session' },
        constraints: {
          type: 'array',
          items: { type: 'string' },
          description: 'Constraints to apply to the child session',
        },
      },
    },
    {
      name: 'writeback_to_parent',
      description:
        'Write results back to the parent session. The platform resolves the parent internally; the caller does not specify the parent.',
      parameters: {
        summary: { type: 'string', description: 'Summary of work completed' },
        blocks: {
          type: 'array',
          items: { type: 'object' },
          description: 'Optional structured output blocks',
        },
      },
    },
  ];
}

export type PlatformToolContext = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
};

export async function invokePlatformTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: PlatformToolContext,
) {
  const roleManager = createRoleManagerService(ctx.db, ctx.piClient);

  if (toolName === 'spawn_session') {
    const input = buildSpawnSessionInput({
      role: String(args.role ?? 'worker'),
      target: String(args.target ?? ''),
      constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    });

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
      role: input.role,
      target: input.target,
      constraints: input.constraints,
    });

    return { session_id: result.sessionId, pi_session_id: result.piSessionId };
  }

  if (toolName === 'writeback_to_parent') {
    const input = buildWritebackToParentInput({
      summary: String(args.summary ?? ''),
      blocks: Array.isArray(args.blocks) ? args.blocks : null,
    });

    await roleManager.writebackToParent({
      childSessionId: ctx.sessionId,
      summary: input.summary,
      blocks: input.blocks,
    });

    return { ok: true };
  }

  throw new Error(`unknown_tool:${toolName}`);
}

export async function registerPlatformTools(piClient: PiClient) {
  const defs = buildPlatformToolDefs();
  if (piClient.registerTools) {
    await piClient.registerTools(defs);
  }
}
