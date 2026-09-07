import type { PiClient } from '@piplus/pi-client';
import type { RoleManagerDb } from '../role-manager/service';
import { loadRoleCatalog } from './role-catalog';
import { buildRoleManagerToolDefs, invokeRoleManagerTool } from './role-manager-tools';
import { buildAskQuestionToolDef, executeAskQuestion } from './ask-question';

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
  const defs = buildRoleManagerToolDefs(catalog);
  // ask_question 默认加载：对任意项目/角色可用（阻塞等待 + WS 推送 + 回填）。
  defs.push(buildAskQuestionToolDef());
  return defs;
}

export async function invokePlatformTool(
  toolName: string,
  args: Record<string, unknown>,
  ctx: PlatformToolContext,
): Promise<unknown> {
  // 优先处理 ask_question：返回 { content, details } 供 pi-client 透传 details。
  if (toolName === 'ask_question') {
    return executeAskQuestion(args, ctx);
  }
  return invokeRoleManagerTool(toolName, args, ctx);
}
