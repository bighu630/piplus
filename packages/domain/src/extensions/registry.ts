import type { PiClient } from '@piplus/pi-client';
import type { RoleManagerDb } from '../role-manager/service';
import { loadRoleCatalog } from './role-catalog';
import { buildRoleManagerToolDefs, invokeRoleManagerTool } from './role-manager-tools';

export type PlatformToolContext = {
  db: RoleManagerDb;
  piClient: PiClient;
  sessionId: string;
  userId: string;
  onSessionCreated?: (payload: { sessionId: string; projectId: string }) => void | Promise<void>;
  onRuntimeStatusChange?: (payload: {
    sessionId: string;
    projectId: string;
    runtimeStatus: 'running' | 'idle';
    error: string | null;
  }) => void | Promise<void>;
};

export async function buildAllToolDefs(db: RoleManagerDb, projectId?: string) {
  const catalog = await loadRoleCatalog(db, projectId);
  return buildRoleManagerToolDefs(catalog);
}

export async function invokePlatformTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: PlatformToolContext,
): Promise<unknown> {
  return invokeRoleManagerTool(toolName, args, ctx);
}
