import type { Hono } from 'hono';
import { createDb } from '@piplus/db/client';
import { messages, messageInjections, projects, roleTemplates, sessionEvents, sessionSyncStates, sessions } from '@piplus/db/schema';
import type { PiClient, PiContentBlock } from '@piplus/pi-client';
import { parseLocator } from '@piplus/pi-client/locator';
import { and, asc, desc, eq, inArray, like } from 'drizzle-orm';
import { getDbPath } from '../../../db-context';
import { socketHub } from '../../../ws/server';
import { createEvent } from '../../../ws/protocol';
import { mapPiStreamEventToFrames } from '../../../lib/pi-stream-bridge';
import { createAuditService, findRoleTemplateByVersion, getSetting, startSessionRun } from '@piplus/domain';
import {
  resolveSessionModelWithCapabilities,
  modelSupportsImageInput,
} from '../model-capabilities';
import {
  parseImageAttachments,
  parseModelRef,
  describeImagesWithFallback,
  buildVisionMergedContent,
  parseStoredContentBlocks,
  insertVisionFailureMessage,
  stripMergedPromptPrefix,
  VISION_MERGED_MARKER,
} from '../vision';
import { randomId, nextMessageTime, log } from '../shared';

export function registerChatRoutes(app: Hono, piClient: PiClient) {

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/info:
   *   get:
   *     summary: 获取会话聚合详情
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 返回会话、项目、血缘、角色模板、提示词快照、同步状态和最近事件。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/info', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);

    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, name: projects.name, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [rt] = await db.select({ key: roleTemplates.key, version: roleTemplates.version, name: roleTemplates.name })
      .from(roleTemplates).where(eq(roleTemplates.id, session.roleTemplateId)).limit(1);

    const [parent] = await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, session.parentSessionId ?? '')).limit(1);
    const [root] = await db.select({ id: sessions.id, title: sessions.title }).from(sessions).where(eq(sessions.id, session.rootSessionId)).limit(1);
    const [sync] = await db.select().from(sessionSyncStates).where(eq(sessionSyncStates.sessionId, sessionId)).limit(1);

    const events = await db.select().from(sessionEvents).where(eq(sessionEvents.sessionId, sessionId)).orderBy(desc(sessionEvents.createdAt)).limit(20);

    const runtimeModel = await piClient.getCurrentModel(sessionId);
    const currentModel = runtimeModel ?? (() => {
      if (!session.currentModelProvider || !session.currentModelId) return null;
      // 尝试从可用模型列表中查找 label（如 "DeepSeek V4 Pro"），
      // 如果找不到就用 id 作为 label，避免出现 "deepseek/deepseek-v4-pro" 这种拼接
      const label = session.currentModelId;
      return { provider: session.currentModelProvider, id: session.currentModelId, label };
    })();

    return c.json({
      session: {
        id: session.id,
        title: session.title,
        project_id: session.projectId,
        parent_session_id: session.parentSessionId,
        root_session_id: session.rootSessionId,
        created_by: session.createdBy,
        created_at: new Date(session.createdAt).toISOString(),
        last_run_at: session.lastRunAt ? new Date(session.lastRunAt).toISOString() : null,
        archived_at: session.archivedAt ? new Date(session.archivedAt).toISOString() : null,
        pi_session_id: session.piSessionId,
        pi_session_locator_json: session.piSessionLocatorJson,
        status: session.status,
        runtime_status: session.runtimeStatus,
        current_model: currentModel,
      },
      project: project
        ? { id: project.id, name: project.name }
        : { id: session.projectId, name: 'Unknown project' },
      lineage: {
        parent_session: parent ? { id: parent.id, title: parent.title } : null,
        root_session: root ? { id: root.id, title: root.title } : null,
        depth: session.depth,
      },
      role_template: rt ? { key: rt.key, version: rt.version, name: rt.name } : { key: 'unknown', version: '0', name: 'Unknown' },
      prompts: {
        role_base_prompt_snapshot: session.roleBasePromptSnapshot,
        user_supplied_prompt: session.userSuppliedPrompt,
        parent_supplied_prompt: session.parentSuppliedPrompt,
        compiled_prompt: session.compiledPrompt,
      },
      sync: {
        sync_status: sync?.syncStatus ?? 'idle',
        last_synced_at: sync?.lastSyncedAt ? new Date(sync.lastSyncedAt).toISOString() : null,
        last_pi_message_id: sync?.lastPiMessageId ?? null,
        last_error: sync?.lastError ?? null,
        retry_count: sync?.retryCount ?? 0,
      },
      recent_events: events.map((e) => ({
        id: e.id,
        type: e.type,
        payload: e.payload,
        created_at: new Date(e.createdAt).toISOString(),
      })),
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/planner-role-prompt:
   *   get:
   *     summary: 获取顶层 planner 的角色系统提示词
   *     tags: [Sessions]
   *     security:
   *       - bearerAuth: []
   *     description: 仅顶层 planner 且 idle 可用，返回当前会话保存的 compiled planner prompt，供前端作为普通用户消息再次发送。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       400:
   *         description: 非顶层 planner 或会话繁忙。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/planner-role-prompt', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, roleConfigJson: projects.roleConfigJson }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.depth !== 0) {
      return c.json({ error: { code: 'NOT_PLANNER_ROOT', message: 'Only top-level planner sessions are supported' } }, 400);
    }

    if (session.runtimeStatus !== 'idle') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    // Version-aware template lookup: read project roleConfigJson for planner version
    let roleVersion: string | undefined;
    try {
      const roleConfig = JSON.parse(project.roleConfigJson ?? '{}');
      roleVersion = roleConfig['planner']?.version;
    } catch {
      // If roleConfigJson is malformed, fall back to session's original template
    }

    let template: { key: string; basePrompt: string; name: string } | null = null;
    try {
      template = await findRoleTemplateByVersion(db, 'planner', roleVersion);
    } catch {
      // Template not found — no planner template available for this version
    }

    if (!template) {
      return c.json({ error: { code: 'NOT_PLANNER_ROOT', message: 'No planner role template found for the configured version' } }, 400);
    }

    const prompt = template.basePrompt || session.compiledPrompt;
    return c.json({
      session_id: sessionId,
      prompt,
      prompt_length: prompt.length,
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/chat/messages:
   *   get:
   *     summary: 获取会话消息历史
   *     tags: [Sessions, Chat]
   *     security:
   *       - bearerAuth: []
   *     description: 从 Pi 会话历史中按游标分页读取消息。
   *     responses:
   *       200:
   *         description: 查询成功。
   *       404:
   *         description: 会话不存在或无访问权限。
   */
  app.get('/api/v1/sessions/:sessionId/chat/messages', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const limit = Math.min(Number(c.req.query('limit') ?? '50') || 50, 100);
    const cursor = c.req.query('cursor');
    const piPage = await piClient.getHistory(sessionId, parseLocator(session.piSessionLocatorJson), cursor ?? null, limit);
    const pageRows = piPage.messages;

    // Merge slash_command / error messages from DB (not in Pi session file).
    // 双读兼容：新数据在 message_injections 表，历史旧数据仍在 messages 表，两源按时间归并。
    let dbCommandMessages: Array<typeof pageRows[number]> = [];
    if (!cursor || cursor === '0') {
      const [dbRows, injectionRows] = await Promise.all([
        db.select().from(messages)
          .where(and(eq(messages.sessionId, sessionId), inArray(messages.messageKind, ['slash_command', 'error'])))
          .orderBy(desc(messages.createdAt))
          .limit(20),
        db.select().from(messageInjections)
          .where(and(eq(messageInjections.sessionId, sessionId), inArray(messageInjections.messageKind, ['slash_command', 'error'])))
          .orderBy(desc(messageInjections.createdAt))
          .limit(20),
      ]);
      const mapCommandRow = (row: typeof messages.$inferSelect | typeof messageInjections.$inferSelect) => ({
        id: row.id,
        role: row.role as 'user' | 'assistant',
        text: row.contentText,
        messageKind: row.messageKind as any,
        createdAt: new Date(row.createdAt).toISOString(),
        toolName: undefined,
        toolArgs: undefined,
        contentBlocks: undefined,
      });
      dbCommandMessages = [...dbRows.map(mapCommandRow), ...injectionRows.map(mapCommandRow)]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }

    // Vision relay 用户消息替换（所有分页）：pi 历史中保存的是合并了 "[图片内容识别]" 描述的消息，
    // 用 DB 中保留原始文本 + 图片附件的消息行替换，历史展示原始图片而非描述文本。
    // 必须在 allMessages 组装之前执行（展开 pageRows 后修改不再影响结果）。
    // DB createdAt 由 nextMessageTime() 生成（与 pi 历史时间戳毫秒级对齐）。
    // 双读兼容：新数据在 message_injections（messageKind='vision_relay'），历史旧数据仍在 messages 表（role='user' + blocks 含 image）。
    // 配对策略：对页内每条带合并标记的消息，在全部 vision relay 行中找时间最接近的未使用行（贪心，5 分钟容差）。
    // 不用顺序一一配对——分页时页内只是全量消息的子集，顺序会错位。
    {
      const [dbUserRows, injectionRelayRows] = await Promise.all([
        db.select().from(messages)
          .where(and(
            eq(messages.sessionId, sessionId),
            eq(messages.role, 'user'),
            eq(messages.messageKind, 'normal'),
            like(messages.contentBlocksJson, '%"type":"image"%'),
          ))
          .orderBy(asc(messages.createdAt)),
        db.select().from(messageInjections)
          .where(and(
            eq(messageInjections.sessionId, sessionId),
            eq(messageInjections.messageKind, 'vision_relay'),
          ))
          .orderBy(asc(messageInjections.createdAt)),
      ]);
      const visionRelayRows = [
        ...dbUserRows.filter((row) => {
          const blocks = parseStoredContentBlocks(row.contentBlocksJson);
          return blocks !== null && blocks.some((block) => block.type === 'image');
        }),
        ...injectionRelayRows,
      ];
      if (visionRelayRows.length > 0) {
        // 页内带合并标记的用户消息（按时间升序）
        const mergedIndexes = pageRows
          .map((m, i) => ({ index: i, time: m.createdAt ? new Date(m.createdAt).getTime() : 0 }))
          .filter(({ index }) => pageRows[index].role === 'user' && pageRows[index].text.includes(VISION_MERGED_MARKER))
          .sort((a, b) => a.time - b.time);
        const usedRows = new Set<number>();
        for (const target of mergedIndexes) {
          // 时间最近贪心配对：在未使用的 vision relay 行中找与当前合并消息时间最接近的
          let best = -1;
          let bestDiff = Infinity;
          for (let j = 0; j < visionRelayRows.length; j++) {
            if (usedRows.has(j)) continue;
            const diff = Math.abs(new Date(visionRelayRows[j].createdAt).getTime() - target.time);
            if (diff < bestDiff) {
              bestDiff = diff;
              best = j;
            }
          }
          if (best === -1 || bestDiff > 5 * 60_000) continue;
          usedRows.add(best);
          const row = visionRelayRows[best];
          pageRows[target.index] = {
            id: row.id,
            role: row.role as 'user',
            text: row.contentText,
            messageKind: 'normal',
            createdAt: new Date(row.createdAt).toISOString(),
            toolName: undefined,
            toolArgs: undefined,
            contentBlocks: parseStoredContentBlocks(row.contentBlocksJson) ?? undefined,
          } as typeof pageRows[number];
        }
      }
    }

    const allMessages = [...dbCommandMessages.reverse(), ...pageRows];

    return c.json({
      session_id: sessionId,
      cursor: cursor ?? null,
      next_cursor: piPage.nextCursor,
      messages: allMessages.map((row: typeof pageRows[number]) => ({
        id: row.id,
        role: row.role,
        message_kind: row.messageKind ?? 'normal',
        source_session_id: null,
        content_text: row.role === 'user' ? stripMergedPromptPrefix(row.text) : row.text,
        content_blocks: row.contentBlocks?.map((block) => block.type === 'text'
          ? { type: 'text' as const, text: row.role === 'user' ? stripMergedPromptPrefix(block.text) : block.text }
          : {
              type: 'image' as const,
              mime_type: block.mimeType,
              media_type: block.mediaType,
              filename: block.filename,
              uri: block.uri,
              data_base64: block.dataBase64,
            }) ?? null,
        created_at: row.createdAt,
        tool_name: row.toolName ?? null,
        tool_args_json: row.toolArgs ? JSON.stringify(row.toolArgs) : null,
        details: row.details ?? null,
      })),
    });
  });

  /**
   * @swagger
   * /api/v1/sessions/{sessionId}/chat/messages:
   *   post:
   *     summary: 发送会话消息
   *     tags: [Sessions, Chat]
   *     security:
   *       - bearerAuth: []
   *     description: 受理用户消息并异步启动 LLM；生成结果通过 WebSocket chat_stream 推送。
   *     responses:
   *       202:
   *         description: 已受理，返回 run_id 与 message_id。
   *       400:
   *         description: 消息内容为空。
   *       409:
   *         description: 会话繁忙。
   */
  app.post('/api/v1/sessions/:sessionId/chat/messages', async (c) => {
    const db = createDb(`file:${getDbPath()}`);
    const userId = (c as any).get('userId') as string;
    const sessionId = decodeURIComponent(c.req.param('sessionId'));
    const body = await c.req.json().catch(() => ({}));
    const content = String((body as { content?: string }).content ?? '').trim();
    const rawContent = content;
    let attachmentParse: ReturnType<typeof parseImageAttachments>;
    try {
      attachmentParse = parseImageAttachments((body as { attachments?: unknown }).attachments);
    } catch {
      return c.json({ error: { code: 'INVALID_ATTACHMENTS', message: 'Attachments must be an array' } }, 400);
    }
    if ('error' in attachmentParse) {
      return c.json({ error: attachmentParse.error }, attachmentParse.status);
    }

    if (!content && attachmentParse.images.length === 0) {
      return c.json({ error: { code: 'EMPTY_MESSAGE', message: 'Message content or image attachment is required' } }, 400);
    }

    const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    if (!session) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    const [project] = await db.select({ id: projects.id, createdBy: projects.createdBy, projectPath: projects.projectPath }).from(projects).where(eq(projects.id, session.projectId)).limit(1);
    if (!project || project.createdBy !== userId) return c.json({ error: { code: 'NOT_FOUND', message: 'Session not found' } }, 404);

    if (session.runtimeStatus === 'running' || session.runtimeStatus === 'stopping') {
      return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
    }

    // Intercept slash commands — execute locally if recognized, otherwise send to agent
    if (content && /^\s*\//.test(content)) {
      const commandResult = await piClient.executeCommand(sessionId, content);
      if (commandResult !== null) {
        const now = nextMessageTime();
        const userMsgId = randomId('message');
        const assistantMsgId = randomId('message');

        await db.insert(messageInjections).values({
          id: userMsgId, sessionId, messageKind: 'slash_command',
          role: 'user', contentText: content,
          contentBlocksJson: null, createdAt: now,
        } as any);

        const responseNow = nextMessageTime();
        await db.insert(messageInjections).values({
          id: assistantMsgId, sessionId, messageKind: 'slash_command',
          role: 'assistant', contentText: commandResult,
          contentBlocksJson: null, createdAt: responseNow,
        } as any);

        log.info('slash command executed', { sessionId, content });
        await createAuditService(db).record(userId, "message.sent", "session", sessionId, { message_id: userMsgId });

        // Push via WebSocket for real-time UI
        socketHub.sendToSession(sessionId, createEvent('chat_stream', { session_id: sessionId, phase: 'start' }));
        socketHub.sendToSession(sessionId, createEvent('chat_stream', { session_id: sessionId, delta: commandResult, phase: 'delta' }));
        socketHub.sendToSession(sessionId, createEvent('chat_stream', { session_id: sessionId, phase: 'complete' }));

        socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
        socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));

        return c.json({ accepted: true, session_id: sessionId, run_id: `cmd_${crypto.randomUUID().slice(0, 8)}`, message_id: assistantMsgId }, 202);
      }
      // Unknown command — fall through, send to agent for processing
      log.info('unknown slash command, forwarding to agent', { sessionId, content });
    }

    const currentModel = await resolveSessionModelWithCapabilities(piClient, session);
    let effectiveContent = rawContent;
    let effectiveImages = attachmentParse.images;
    // vision relay 成功标记：落库时据此决定走注入表（vision_relay）而非 messages 表
    let visionRelayUsed = false;
    if (attachmentParse.images.length > 0 && currentModel !== null && !modelSupportsImageInput(currentModel)) {
      const visionEnabled = (await getSetting(db, 'vision_enabled')) === 'true';
      const primaryRef = visionEnabled ? parseModelRef(await getSetting(db, 'vision_model')) : null;
      if (primaryRef) {
        const fallbackRef = parseModelRef(await getSetting(db, 'vision_fallback_model'));
        // 原子认领 running：两个并发 POST 可能同时通过上方 busy 检查，
        // 这里用条件更新保证只有一个请求进入 describe（最长 90s），防止双 describe / 双 run
        const claimed = await db.update(sessions)
          .set({ runtimeStatus: 'running', updatedAt: new Date() })
          .where(and(eq(sessions.id, sessionId), eq(sessions.runtimeStatus, 'idle')))
          .returning({ id: sessions.id });
        if (claimed.length === 0) {
          return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
        }
        let outcome: Awaited<ReturnType<typeof describeImagesWithFallback>> | undefined;
        try {
          outcome = await describeImagesWithFallback(piClient, primaryRef, fallbackRef, rawContent, attachmentParse.images);
        } finally {
          // run 尚未启动（startSessionRun 内部会重新认领 idle→running）：无论 describe 结果如何
          // 都恢复 idle，防止 insertVisionFailureMessage 抛错等异常路径把会话卡死在 running
          await db.update(sessions).set({ runtimeStatus: 'idle', updatedAt: new Date() }).where(eq(sessions.id, sessionId));
        }
        if (!outcome) {
          // describeImagesWithFallback 内部捕获全部模型错误，理论上不抛；此处兜底（如 finally 恢复失败导致的极端路径）
          await insertVisionFailureMessage(db, sessionId, primaryRef, fallbackRef, '识别调用异常中止');
          return c.json({
            error: { code: 'VISION_DESCRIPTION_FAILED', message: '图片识别失败，消息未发送（多模态识别模型不可用）' },
          }, 400);
        }
        if (!outcome.ok) {
          // 主备都失败：插入 error 历史消息，整条消息拒绝（不落库、不发给文本模型）
          await insertVisionFailureMessage(db, sessionId, primaryRef, fallbackRef, outcome.error);
          return c.json({
            error: { code: 'VISION_DESCRIPTION_FAILED', message: '图片识别失败，消息未发送（多模态识别模型不可用）' },
          }, 400);
        }
        // 成功：描述与用户文本合并，图片本身不发给文本模型
        effectiveContent = buildVisionMergedContent(rawContent, outcome.description);
        effectiveImages = [];
        visionRelayUsed = true;
      } else {
        // 未开启功能或未配置多模态模型：保持原有拒绝行为
        return c.json({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'Current model does not support image input' } }, 400);
      }
    } else if (attachmentParse.images.length > 0 && !modelSupportsImageInput(currentModel)) {
      // currentModel 为 null（模型解析失败）等边界：保持原有拒绝行为，避免进入 60s+ describe 再失败
      return c.json({ error: { code: 'MODEL_DOES_NOT_SUPPORT_IMAGES', message: 'Current model does not support image input' } }, 400);
    }

    const contentBlocks: PiContentBlock[] = [
      ...(rawContent ? [{ type: 'text' as const, text: rawContent }] : []),
      ...attachmentParse.blocks,
    ];

    const now = nextMessageTime();
    const messageId = randomId('message');
    if (visionRelayUsed) {
      // vision relay 成功：原始用户消息（文本 + 图片 blocks）落注入表，不落 messages 表；
      // GET /chat/messages 用该行替换 pi 历史中的合并描述消息（见上方 vision relay 替换逻辑）
      await db.insert(messageInjections).values({
        id: messageId,
        sessionId,
        messageKind: 'vision_relay',
        role: 'user',
        contentText: rawContent,
        contentBlocksJson: contentBlocks.length ? JSON.stringify(contentBlocks) : null,
        createdAt: now,
      } as any);
    } else {
      await db.insert(messages).values({
        id: messageId,
        sessionId,
        piMessageId: null,
        messageKind: 'normal',
        sourceSessionId: null,
        role: 'user',
        contentText: rawContent,
        contentBlocksJson: contentBlocks.length ? JSON.stringify(contentBlocks) : null,
        contentVersion: contentBlocks.length ? 2 : 1,
        createdAt: now,
      } as any);
    }

    log.info('message sent', { sessionId, messageId });
    await createAuditService(db).record(userId, "message.sent", "session", sessionId, { message_id: messageId });

    const eventId = randomId('event');
    await db.insert(sessionEvents).values({
      id: eventId,
      sessionId,
      type: 'chat_message_received',
      payload: JSON.stringify({ message_id: messageId }),
      parentMessageId: null,
      sequence: 1,
      createdAt: now,
    } as any);

    try {
      const run = await startSessionRun({
        db,
        piClient,
        sessionId,
        userId,
        content: effectiveContent,
        images: effectiveImages,
        startedAt: now,
        onStreamEvent: async (event) => {
          for (const frame of mapPiStreamEventToFrames(sessionId, event)) {
            socketHub.sendToSession(sessionId, frame);
          }
        },
        onRuntimeStatusChange: async ({ sessionId: eventSessionId, projectId, runtimeStatus, error }) => {
          socketHub.sendToSession(eventSessionId, createEvent('session.runtime_status_changed', { runtime_status: runtimeStatus, error }, { project_id: projectId, session_id: eventSessionId }));
        },
        onToolSessionCreated: async ({ sessionId: childSessionId, projectId }) => {
          socketHub.broadcast(createEvent('session.created', { session_id: childSessionId }, { project_id: projectId, session_id: childSessionId }));
          socketHub.broadcast(createEvent('tree.changed', { project_id: projectId }, { project_id: projectId }));
        },
        candidateModels: (() => {
          try {
            const parsed = JSON.parse(session.modelFallbacksJson ?? '[]');
            return Array.isArray(parsed) ? parsed : [];
          } catch {
            return [];
          }
        })(),
      });

      socketHub.broadcast(createEvent('session.updated', { session_id: sessionId }, { project_id: session.projectId, session_id: sessionId }));
      socketHub.broadcast(createEvent('tree.changed', { project_id: session.projectId }, { project_id: session.projectId }));

      return c.json({ accepted: true, session_id: sessionId, run_id: run.runId, message_id: messageId }, 202);
    } catch (error) {
      // 并发双 POST 的败者在 startSessionRun 原子认领失败时抛 session_busy，
      // 映射为干净的 409（与 setSessionModel 路由同模式），其余错误原样上抛。
      const message = error instanceof Error ? error.message : 'unknown';
      if (message === 'session_busy') {
        // 消息从未发出（并发败者 / isStreaming 守卫被拒）：删除刚插入的消息行与
        // chat_message_received 事件行，保持历史一致，否则 UI 出现无回复的悬空消息；
        // 用户重试会重新插入。审计记录保留（系统审计日志不随业务行删除）。
        try {
          await db.delete(messages).where(eq(messages.id, messageId));
          await db.delete(messageInjections).where(eq(messageInjections.id, messageId));
          await db.delete(sessionEvents).where(eq(sessionEvents.id, eventId));
        } catch (cleanupErr) {
          log.warn('chat 409: ghost message cleanup failed', { sessionId, messageId, error: String(cleanupErr) });
        }
        return c.json({ error: { code: 'SESSION_BUSY', message: 'Session is currently busy' } }, 409);
      }
      throw error;
    }
  });
}
