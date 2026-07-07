import type { PiToolDef } from '@piplus/pi-client';
import type { PiClient } from '@piplus/pi-client';
import type { RoleCatalog } from './role-catalog';
import type { RoleManagerDb } from '../role-manager/service';
import { messages, sessions } from '@piplus/db/schema';
import { and, eq } from 'drizzle-orm';
import { createRoleManagerService } from '../role-manager/service';
import { startSessionRun } from '../session/runtime';
import { setRequestContext, getRequestContext } from '../session/request-context';

const WRITEBACK_REMINDER_INTERVAL_MS = 15 * 1000;

function labelForRole(key: string) {
  const map: Record<string, string> = {
    planner: '规划者', worker: '执行者', reviewer: '审查者', feature_lead: '需求负责人', bugfix_lead: 'Bug负责人', blank: '空白',
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
          wait: {
            type: 'boolean',
            description: 'Whether to wait for the child session to complete and return its results. Use true for workers, false for roles that need to interact with the user independently.',
          },
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
    {
      name: 'send_message_to_session',
      description:
        'Send a follow-up message to an existing child session (e.g. ask a reviewer to continue after fixes). Only direct child sessions are allowed.',
      parameters: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'The target child session id (must be a direct child of the current session)' },
          content: { type: 'string', description: 'The message to send to the child session' },
          wait: {
            type: 'boolean',
            description: 'Whether to wait for the child session to process this message and return its writeback result',
          },
        },
        required: ['session_id', 'content'],
      },
    },
  ];
}

export type RoleManagerToolContext = {
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

    const wait = Boolean(args.wait ?? false);
    const role = String(args.role ?? 'worker');
    const requestId = `req_${crypto.randomUUID().slice(0, 12)}`;
    const waitPrompt = wait
      ? '所有任务完成后，必须调用`writeback_to_parent`报告结果给父会话'
      : undefined;
      // ? 'When you are done, you must call `writeback_to_parent` to report the result back to the parent session before stopping. '

    const result = await roleManager.spawnSession({
      projectId: parent.projectId,
      parentSessionId: ctx.sessionId,
      createdBy: ctx.userId,
      role,
      objective: String(args.objective ?? ''),
      scope: args.scope ? String(args.scope) : undefined,
      task: args.task ? String(args.task) : undefined,
      parentSuppliedPrompt: waitPrompt,
      constraints: Array.isArray(args.constraints) ? args.constraints.map(String) : [],
    });

    console.log('[role-manager-tools] spawn_session created', {
      parentSessionId: ctx.sessionId,
      childSessionId: result.sessionId,
      role,
      requestId,
      wait,
    });

    // Broadcast new session to frontend via the registered callback
    await ctx.onSessionCreated?.({
      sessionId: result.sessionId,
      projectId: parent.projectId,
    });

    // Always auto-start the child session — no extra kickoff message needed.
    // The compiled prompt (with objective/scope/task) is already injected as
    // the system prompt via piClient.createSession. The AI executes based on
    // that prompt alone.
    await startChildSessionRun(ctx, result.sessionId, '', requestId, ctx.onSessionCreated);

    if (wait) {
      return await waitForChildWriteback(ctx, result.sessionId, requestId);
    }

    return {
      status: 'created',
      session_id: result.sessionId,
      message: `已创建 ${labelForRole(role)} 子会话（点击左侧栏可切换）`,
    };
  }

  if (toolName === 'send_message_to_session') {
    const targetSessionId = String(args.session_id ?? '');
    const content = String(args.content ?? '');
    const wait = Boolean(args.wait ?? false);

    if (!targetSessionId) throw new Error('missing_session_id');
    if (!content) throw new Error('missing_content');

    // 校验目标是当前 session 的直接子 session
    const [child] = await ctx.db
      .select({ id: sessions.id, parentSessionId: sessions.parentSessionId })
      .from(sessions)
      .where(eq(sessions.id, targetSessionId))
      .limit(1);

    if (!child) throw new Error('target_session_not_found');
    if (child.parentSessionId !== ctx.sessionId) throw new Error('not_direct_child_session');

    const requestId = `req_${crypto.randomUUID().slice(0, 12)}`;

    console.log('[role-manager-tools] send_message_to_session', {
      parentSessionId: ctx.sessionId,
      targetSessionId,
      requestId,
      wait,
    });

    // 启动目标 session 处理这条后续消息
    await startChildSessionRun(ctx, targetSessionId, content, requestId, ctx.onSessionCreated);

    if (wait) {
      return await waitForChildWriteback(ctx, targetSessionId, requestId);
    }

    return {
      status: 'sent',
      session_id: targetSessionId,
      message: '已向子会话发送消息',
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

// ── Internal helpers ──

/** Always start a child session run (independent of wait). */
async function startChildSessionRun(
  ctx: RoleManagerToolContext,
  childSessionId: string,
  content: string,
  requestId: string,
  onToolSessionCreated?: (payload: { sessionId: string; projectId: string }) => void | Promise<void>,
) {
  setRequestContext(childSessionId, requestId);
  console.log('[role-manager-tools] startChildSessionRun', { childSessionId, requestId });

  await startSessionRun({
    db: ctx.db,
    piClient: ctx.piClient,
    sessionId: childSessionId,
    userId: ctx.userId,
    content,
    requestId,
    onToolSessionCreated,
    onRuntimeStatusChange: ctx.onRuntimeStatusChange,
  });
}

/** Poll for a writeback from a child session, keyed by (sourceSessionId, requestId). */
async function waitForChildWriteback(
  ctx: RoleManagerToolContext,
  childSessionId: string,
  requestId: string,
): Promise<unknown> {
  const timeoutMs = 10 * 60 * 1000;
  const pollIntervalMs = 2000;
  const deadline = Date.now() + timeoutMs;
  let lastReminderAt = Date.now();

  while (Date.now() < deadline) {
    const [parent] = await ctx.db
      .select({ runtimeStatus: sessions.runtimeStatus })
      .from(sessions)
      .where(eq(sessions.id, ctx.sessionId))
      .limit(1);

    if (!parent) {
      console.log('[role-manager-tools] waitForChildWriteback parent missing', {
        parentSessionId: ctx.sessionId,
        childSessionId,
        requestId,
      });
      return {
        status: 'cancelled',
        session_id: childSessionId,
        message: '父会话不存在，已取消等待子会话结果',
      };
    }

    if (parent.runtimeStatus === 'stopping') {
      console.log('[role-manager-tools] waitForChildWriteback parent stopping', {
        parentSessionId: ctx.sessionId,
        childSessionId,
        requestId,
      });
      return {
        status: 'cancelled',
        session_id: childSessionId,
        message: '父会话正在停止，已取消等待子会话结果',
      };
    }

    const [writeback] = await ctx.db
      .select({ summary: messages.contentText, blocksJson: messages.contentBlocksJson })
      .from(messages)
      .where(
        and(
          eq(messages.sourceSessionId, childSessionId),
          eq(messages.messageKind, 'writeback'),
          eq(messages.requestId, requestId),
        ),
      )
      .limit(1);

    if (writeback) {
      let blocks = null;
      if (writeback.blocksJson) {
        try {
          blocks = JSON.parse(writeback.blocksJson);
        } catch {
          /* ignore */
        }
      }
      console.log('[role-manager-tools] waitForChildWriteback matched', {
        childSessionId,
        requestId,
      });
      return {
        status: 'completed',
        session_id: childSessionId,
        summary: writeback.summary,
        blocks,
      };
    }

    const [child] = await ctx.db
      .select({ runtimeStatus: sessions.runtimeStatus })
      .from(sessions)
      .where(eq(sessions.id, childSessionId))
      .limit(1);

    const now = Date.now();
    if (child?.runtimeStatus === 'idle' && now - lastReminderAt >= WRITEBACK_REMINDER_INTERVAL_MS) {
      lastReminderAt = now;
      const reminder = 'Reminder: if you have finished, you must call `writeback_to_parent` before stopping. Keep using the current requestId so the parent can match your writeback.';
      console.log('[role-manager-tools] waitForChildWriteback reminder', {
        childSessionId,
        requestId,
      });
      await startChildSessionRun(ctx, childSessionId, reminder, requestId, ctx.onSessionCreated);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.log('[role-manager-tools] waitForChildWriteback timeout', {
    childSessionId,
    requestId,
  });

  return {
    status: 'timeout',
    session_id: childSessionId,
    message: '子会话超时未返回结果',
  };
}
