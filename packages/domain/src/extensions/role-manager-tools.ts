import type { PiToolDef } from '@piplus/pi-client';
import type { PiClient } from '@piplus/pi-client';
import type { RoleCatalog } from './role-catalog';
import type { RoleManagerDb } from '../role-manager/service';
import { messages, projects, sessions } from '@piplus/db/schema';
import { and, eq, like } from 'drizzle-orm';
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
    {
      name: 'cross_project_ask',
      description:
        'Ask a question to another project and wait for a reply. The target project\'s agent will process the question and respond. ' +
        'Use this when you need information or help from another project. ' +
        'The target project must belong to the same user.',
      parameters: {
        type: 'object',
        properties: {
          projectName: { type: 'string', description: 'The name of the target project to ask' },
          question: { type: 'string', description: 'The question or request to send to the other project' },
          briefDescription: { type: 'string', description: 'A very short description of the question (optional, defaults to the first 80 characters of the question)' },
        },
        required: ['projectName', 'question'],
      },
    },
    {
      name: 'cross_project_reply',
      description:
        'Reply to a cross-project question received from another project. ' +
        'Call this after processing a question from cross_project_ask. ' +
        'The reply will be sent back to the asking project.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'The reply content to send back' },
          blocks: {
            type: 'array',
            items: { type: 'object' },
            description: 'Optional structured content blocks',
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

  if (toolName === 'cross_project_ask') {
    const projectName = String(args.projectName ?? '');
    const question = String(args.question ?? '');
    const briefDescription = args.briefDescription ? String(args.briefDescription) : question.slice(0, 80);

    if (!projectName) throw new Error('missing_project_name');
    if (!question) throw new Error('missing_question');

    // Get current session's project
    const [currentSession] = await ctx.db
      .select({ projectId: sessions.projectId })
      .from(sessions)
      .where(eq(sessions.id, ctx.sessionId))
      .limit(1);
    if (!currentSession) throw new Error('session_not_found');
    const sourceProjectId = currentSession.projectId;

    // Find target project by name (case-insensitive fuzzy match)
    const [targetProject] = await ctx.db
      .select({ id: projects.id, name: projects.name, createdBy: projects.createdBy })
      .from(projects)
      .where(
        and(
          like(projects.name, `%${projectName}%`),
          eq(projects.createdBy, ctx.userId),
        ),
      )
      .limit(1);
    if (!targetProject) {
      return {
        status: 'error',
        message: `未找到匹配的项目「${projectName}」`,
      };
    }

    // Same project check
    if (targetProject.id === sourceProjectId) {
      return {
        status: 'error',
        message: '不能向当前项目发起跨项目询问，请使用 spawn_session 创建子会话',
      };
    }

    // Create a blank session in the target project
    const roleManager = createRoleManagerService(ctx.db, ctx.piClient);
    const newSession = await roleManager.createTopLevelBlankSession({
      projectId: targetProject.id,
      createdBy: ctx.userId,
    });

    const requestId = `req_${crypto.randomUUID().slice(0, 12)}`;
    const crossProjectSource = JSON.stringify({
      requestId,
      fromProjectId: sourceProjectId,
      fromSessionId: ctx.sessionId,
    });

    // Set crossProjectSourceJson on the new session
    await ctx.db.update(sessions)
      .set({ crossProjectSourceJson: crossProjectSource })
      .where(eq(sessions.id, newSession.sessionId));

    // Broadcast the new session to the frontend
    await ctx.onSessionCreated?.({
      sessionId: newSession.sessionId,
      projectId: targetProject.id,
    });

    // Get source project name for context in the question
    const [sourceProject] = await ctx.db
      .select({ name: projects.name })
      .from(projects)
      .where(eq(projects.id, sourceProjectId))
      .limit(1);
    const sourceProjectName = sourceProject?.name ?? '未知项目';

    // Wrap the question with cross-project context so the target agent understands
    const crossProjectContent = [
      `【来自项目「${sourceProjectName}」的跨项目询问】`,
      `摘要：${briefDescription}`,
      '',
      question,
      '',
      '---',
      '请处理以上问题，完成后调用 `cross_project_reply` 工具回复。',
      `回复时请提供答案摘要作为 summary，可选附加结构化内容。`,
    ].join('\n');

    // Start the session with the question as content
    await startChildSessionRun(ctx, newSession.sessionId, crossProjectContent, requestId, ctx.onSessionCreated);

    // Poll for reply
    return await waitForCrossProjectReply(ctx, requestId);
  }

  if (toolName === 'cross_project_reply') {
    const summary = String(args.summary ?? '');
    const blocks = Array.isArray(args.blocks) ? args.blocks : null;

    if (!summary) throw new Error('missing_summary');

    // Read cross-project source info from current session
    const [session] = await ctx.db
      .select({ crossProjectSourceJson: sessions.crossProjectSourceJson })
      .from(sessions)
      .where(eq(sessions.id, ctx.sessionId))
      .limit(1);
    if (!session) throw new Error('session_not_found');
    if (!session.crossProjectSourceJson) {
      return {
        status: 'error',
        message: '当前会话不是跨项目询问的目标会话，无法使用 cross_project_reply',
      };
    }

    let source: { requestId: string; fromProjectId: string; fromSessionId: string };
    try {
      source = JSON.parse(session.crossProjectSourceJson);
    } catch {
      throw new Error('invalid_cross_project_source');
    }

    const { requestId, fromProjectId, fromSessionId } = source;

    if (!requestId || !fromSessionId) throw new Error('invalid_cross_project_source');

    // Write reply to the source session's messages
    const messageId = `msg_${crypto.randomUUID().slice(0, 12)}`;
    const timestamp = new Date();
    await ctx.db.insert(messages).values({
      id: messageId,
      sessionId: fromSessionId,
      piMessageId: null,
      messageKind: 'cross_project_reply',
      sourceSessionId: ctx.sessionId,
      role: 'assistant',
      contentText: summary,
      contentBlocksJson: blocks ? JSON.stringify(blocks) : null,
      contentVersion: 1,
      requestId,
      createdAt: timestamp,
    } as any);

    // Update session activity timestamps
    await ctx.db.update(sessions)
      .set({ lastActivityAt: timestamp, updatedAt: timestamp })
      .where(eq(sessions.id, ctx.sessionId));

    return { ok: true, message: '跨项目回复已发送' };
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

  // Query child session to get candidate models for fallback
  const [childSession] = await ctx.db
    .select({ modelFallbacksJson: sessions.modelFallbacksJson })
    .from(sessions)
    .where(eq(sessions.id, childSessionId))
    .limit(1);

  let candidateModels: Array<{ provider: string; id: string; thinkingLevel?: string | null }> = [];
  if (childSession?.modelFallbacksJson) {
    try {
      const parsed = JSON.parse(childSession.modelFallbacksJson);
      if (Array.isArray(parsed)) {
        candidateModels = parsed;
      }
    } catch {
      // ignore parse error
    }
  }

  await startSessionRun({
    db: ctx.db,
    piClient: ctx.piClient,
    sessionId: childSessionId,
    userId: ctx.userId,
    content,
    requestId,
    candidateModels,
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
  let reminderCount = 0;

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
      .select({
        runtimeStatus: sessions.runtimeStatus,
        lastRuntimeError: sessions.lastRuntimeError,
        modelFallbacksJson: sessions.modelFallbacksJson,
        compiledPrompt: sessions.compiledPrompt,
        currentModelProvider: sessions.currentModelProvider,
        currentModelId: sessions.currentModelId,
      })
      .from(sessions)
      .where(eq(sessions.id, childSessionId))
      .limit(1);

    // Check if child has produced ANY output (assistant messages)
    const [anyOutput] = await ctx.db
      .select({ id: messages.id })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, childSessionId),
          eq(messages.role, 'assistant'),
        ),
      )
      .limit(1);
    const hasNoOutput = !anyOutput;

    const now = Date.now();

    // If child failed (idle + explicit error), try candidates or return failure.
    if (child?.runtimeStatus === 'idle' && child?.lastRuntimeError) {
      let remainingCandidates: Array<{ provider: string; id: string; thinkingLevel?: string | null }> = [];
      if (child?.modelFallbacksJson) {
        try {
          const parsed = JSON.parse(child.modelFallbacksJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            remainingCandidates = parsed;
          }
        } catch { /* ignore */ }
      }

      if (remainingCandidates.length > 0) {
        // Pick next candidate and remove it from the list
        const [nextCandidate, ...rest] = remainingCandidates;
        const updatedFallbacks = rest.length > 0 ? JSON.stringify(rest) : null;

        console.log('[role-manager-tools] waitForChildWriteback switching to candidate model', {
          childSessionId,
          requestId,
          from: `${child.currentModelProvider}/${child.currentModelId}`,
          to: `${nextCandidate.provider}/${nextCandidate.id}`,
          remaining: rest.length,
          reason: 'error',
        });

        // Switch child's model to the candidate
        await ctx.db.update(sessions)
          .set({
            currentModelProvider: nextCandidate.provider,
            currentModelId: nextCandidate.id,
            modelFallbacksJson: updatedFallbacks ?? '',
            lastRuntimeError: '',
          })
          .where(eq(sessions.id, childSessionId));

        // Restart child with the new model and the original task
        const retryContent = child.compiledPrompt || `原始执行因模型故障（${child.lastRuntimeError}）失败，请重新完成任务。`;
        await startChildSessionRun(ctx, childSessionId, retryContent, requestId, ctx.onSessionCreated);

        // Continue polling — wait for this new attempt to complete
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      // No more candidates — return error to parent
      console.log('[role-manager-tools] waitForChildWriteback child failed (no candidates left)', {
        childSessionId,
        requestId,
        error: child.lastRuntimeError,
      });
      return {
        status: 'failed',
        session_id: childSessionId,
        message: `子会话执行失败：${child.lastRuntimeError}`,
        error: child.lastRuntimeError,
      };
    }

    // Child is idle with no writeback and no output — try remaining
    // candidates before giving up. The model may have produced no output
    // without throwing (silent failure).
    if (child?.runtimeStatus === 'idle' && hasNoOutput) {
      let remainingCandidates: Array<{ provider: string; id: string; thinkingLevel?: string | null }> = [];
      if (child?.modelFallbacksJson) {
        try {
          const parsed = JSON.parse(child.modelFallbacksJson);
          if (Array.isArray(parsed) && parsed.length > 0) {
            remainingCandidates = parsed;
          }
        } catch { /* ignore */ }
      }

      if (remainingCandidates.length > 0) {
        const [nextCandidate, ...rest] = remainingCandidates;
        const updatedFallbacks = rest.length > 0 ? JSON.stringify(rest) : null;

        console.log('[role-manager-tools] waitForChildWriteback switching to candidate model (no output)', {
          childSessionId,
          requestId,
          from: `${child.currentModelProvider}/${child.currentModelId}`,
          to: `${nextCandidate.provider}/${nextCandidate.id}`,
          remaining: rest.length,
          reminderCount,
        });

        await ctx.db.update(sessions)
          .set({
            currentModelProvider: nextCandidate.provider,
            currentModelId: nextCandidate.id,
            modelFallbacksJson: updatedFallbacks ?? '',
            lastRuntimeError: '',
          })
          .where(eq(sessions.id, childSessionId));

        const retryContent = child.compiledPrompt || '原始执行未产生输出，请重新完成任务。';
        await startChildSessionRun(ctx, childSessionId, retryContent, requestId, ctx.onSessionCreated);

        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }

      console.log('[role-manager-tools] waitForChildWriteback child failed (no output, no candidates)', {
        childSessionId,
        requestId,
        reminderCount,
      });
      return {
        status: 'failed',
        session_id: childSessionId,
        message: '子会话执行失败：模型未产生任何输出',
        error: '模型未产生任何输出',
      };
    }

    if (child?.runtimeStatus === 'idle' && now - lastReminderAt >= WRITEBACK_REMINDER_INTERVAL_MS) {
      lastReminderAt = now;
      reminderCount++;
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

/**
 * Poll for a cross-project reply, keyed by (sessionId, messageKind, requestId).
 * Unlike waitForChildWriteback, the reply is written DIRECTLY to the asking session's
 * messages table (sessionId = ctx.sessionId), not to a parent session.
 */
async function waitForCrossProjectReply(
  ctx: RoleManagerToolContext,
  requestId: string,
): Promise<unknown> {
  const timeoutMs = 10 * 60 * 1000;
  const pollIntervalMs = 2000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    // Check if the asking session is still active
    const [session] = await ctx.db
      .select({ runtimeStatus: sessions.runtimeStatus })
      .from(sessions)
      .where(eq(sessions.id, ctx.sessionId))
      .limit(1);

    if (!session) {
      console.log('[role-manager-tools] waitForCrossProjectReply session missing', {
        sessionId: ctx.sessionId,
        requestId,
      });
      return {
        status: 'cancelled',
        message: '当前会话不存在，已取消等待跨项目回复',
      };
    }

    if (session.runtimeStatus === 'stopping') {
      console.log('[role-manager-tools] waitForCrossProjectReply session stopping', {
        sessionId: ctx.sessionId,
        requestId,
      });
      return {
        status: 'cancelled',
        message: '当前会话正在停止，已取消等待跨项目回复',
      };
    }

    const [reply] = await ctx.db
      .select({ summary: messages.contentText, blocksJson: messages.contentBlocksJson })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, ctx.sessionId),
          eq(messages.messageKind, 'cross_project_reply'),
          eq(messages.requestId, requestId),
        ),
      )
      .limit(1);

    if (reply) {
      let blocks = null;
      if (reply.blocksJson) {
        try {
          blocks = JSON.parse(reply.blocksJson);
        } catch {
          /* ignore */
        }
      }
      console.log('[role-manager-tools] waitForCrossProjectReply matched', {
        sessionId: ctx.sessionId,
        requestId,
      });
      return {
        status: 'completed',
        summary: reply.summary,
        blocks,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  console.log('[role-manager-tools] waitForCrossProjectReply timeout', {
    sessionId: ctx.sessionId,
    requestId,
  });

  return {
    status: 'timeout',
    message: '目标项目未在 10 分钟内回复，已超时',
  };
}
