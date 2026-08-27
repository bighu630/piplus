import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { createPiClient, mapAgentSessionEvent } from './client';
import { registerAgentStartSystemPrompt } from './client/session-lifecycle';

describe('pi client gateway', () => {
  test('createSession returns a persistent pi session locator path', async () => {
    const client = createPiClient();
    const result = await client.createSession({ prompt: 'hello', title: 'Test' });
    expect(result.locator.sessionFile).toBeTruthy();
    expect(result.locator.sessionFile).toContain('/.pi/agent/sessions/');
  });

  test('getHistory starts from the most recent page and paginates backward', async () => {
    const manager = SessionManager.create(process.cwd());
    for (const [role, text] of [
      ['user', 'u1'],
      ['assistant', 'a1'],
      ['user', 'u2'],
      ['assistant', 'a2'],
      ['user', 'u3'],
      ['assistant', 'a3'],
    ] as const) {
      if (role === 'user') {
        manager.appendMessage({
          role,
          content: text,
          timestamp: Date.now(),
        });
      } else {
        manager.appendMessage({
          role,
          content: [{ type: 'text', text }],
          api: 'test',
          provider: 'test',
          model: 'test',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        });
      }
    }

    const locator = {
      piSessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile()!,
    };

    const client = createPiClient();
    const latestPage = await client.getHistory('persisted_history', locator, null, 2);
    expect(latestPage.messages.map((message) => message.text)).toEqual(['u3', 'a3']);
    expect(latestPage.nextCursor).toBe('4');

    const olderPage = await client.getHistory('persisted_history', locator, latestPage.nextCursor, 2);
    expect(olderPage.messages.map((message) => message.text)).toEqual(['u2', 'a2']);
    expect(olderPage.nextCursor).toBe('2');
  });

  test('restoreRuntime rejects invalid locators', async () => {
    const client = createPiClient();
    await expect(
      client.restoreRuntime('broken_session', {
        piSessionId: 'pi_broken',
        sessionFile: '/tmp/does-not-exist/session.jsonl',
      }),
    ).rejects.toThrow('pi_session_runtime_unavailable');
  });

  test('getHistory reads user and assistant messages from a persisted pi session file', async () => {
    const manager = SessionManager.create(process.cwd());
    manager.appendMessage({
      role: 'user',
      content: 'hello from persisted history',
      timestamp: Date.now(),
    });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'assistant persisted reply' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });

    const locator = {
      piSessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile()!,
    };

    const client = createPiClient();
    const page = await client.getHistory('persisted_history', locator, null, 20);
    expect(page.messages.map((message) => message.text)).toEqual([
      'hello from persisted history',
      'assistant persisted reply',
    ]);
  });

  test('getHistory preserves user image content blocks from persisted pi session history', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-client-history-'));
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session', version: 2, id: 'pi_test_history', timestamp: '2026-06-26T04:05:00.000Z', cwd: process.cwd() })}\n${JSON.stringify({
        type: 'message',
        id: 'msg_user_1',
        parentId: null,
        timestamp: '2026-06-26T04:05:00.000Z',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'please inspect this' },
            { type: 'image', data: 'ZmFrZQ==', mimeType: 'image/png' },
          ],
          timestamp: Date.now(),
        },
      })}\n`,
    );

    const client = createPiClient();
    const page = await client.getHistory('persisted_history', {
      piSessionId: 'pi_test_history',
      sessionFile,
    }, null, 20);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      role: 'user',
      text: 'please inspect this',
      contentBlocks: [
        { type: 'text', text: 'please inspect this' },
        {
          type: 'image',
          mediaType: 'image/png',
          mimeType: 'image/png',
          dataBase64: 'ZmFrZQ==',
          filename: null,
          uri: null,
        },
      ],
    });
  });

  test('getHistory 透传 toolResult 的 details（ask_question 结果渲染依赖）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pi-client-history-details-'));
    const sessionFile = join(dir, 'session.jsonl');
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: 'session', version: 2, id: 'pi_test_details', timestamp: '2026-08-26T04:05:00.000Z', cwd: process.cwd() })}\n` +
        `${JSON.stringify({
          type: 'message',
          id: 'msg_tool_1',
          parentId: null,
          timestamp: '2026-08-26T04:06:00.000Z',
        message: {
          role: 'toolResult',
          toolName: 'ask_question',
          toolCallId: 'tc_1',
          content: [{ type: 'text', text: '用户选择：A' }],
          details: { question: 'Q?', options: ['A', 'B'], answer: 'A', multiSelect: false, wasCustom: false },
          isError: false,
          timestamp: Date.now(),
        },
      })}\n`,
    );

    const client = createPiClient();
    const page = await client.getHistory('persisted_history', {
      piSessionId: 'pi_test_details',
      sessionFile,
    }, null, 20);
    expect(page.messages).toHaveLength(1);
    expect(page.messages[0]).toMatchObject({
      role: 'tool',
      messageKind: 'tool',
      toolName: 'ask_question',
      text: '用户选择：A',
      details: { question: 'Q?', options: ['A', 'B'], answer: 'A', multiSelect: false, wasCustom: false },
    });
  });

  test('sendMessage persists user message to pi session history after runtime is closed', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Send Test' });

    await client.restoreRuntime(created.sessionId, created.locator);
    const run = await client.sendMessage(created.sessionId, 'Reply with exactly: persist me');

    expect(run.sessionId).toBe(created.sessionId);
    expect(run.runId).toBeTruthy();

    await client.closeRuntime(created.sessionId);

    const page = await client.getHistory(created.sessionId, created.locator, null, 20);
    // The user message should always be persisted regardless of LLM auth status
    expect(page.messages.length).toBeGreaterThan(0);
    expect(page.messages[0]?.role).toBe('user');
    // 首次对话合并角色 prompt 与用户消息，持久化的 user 消息包含合并后的内容
    expect(page.messages[0]?.text).toContain('Reply with exactly: persist me');
  });

  test('bindToolRuntime registers tool defs without error and session remains usable', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'test' });
    await client.restoreRuntime(created.sessionId, created.locator);

    const tools = [
      {
        name: 'test_ping',
        description: 'Reply with pong and echo the message',
        parameters: {
          type: 'object',
          properties: { message: { type: 'string' } },
          required: ['message'],
        },
      },
    ];

    await client.bindToolRuntime(created.sessionId, tools, async () => ({ pong: true }));

    const page = await client.getHistory(created.sessionId, created.locator, null, 20);
    expect(Array.isArray(page.messages)).toBe(true);

    await client.closeRuntime(created.sessionId);
  });

  test('listAvailableModels returns available models', async () => {
    const client = createPiClient();
    const models = await client.listAvailableModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]).toHaveProperty('provider');
    expect(models[0]).toHaveProperty('id');
    expect(models[0]).toHaveProperty('label');

    // availableThinkingLevels 由后端按 SDK 规则权威计算，这里手算对照验证：
    // 非 reasoning 模型只有 ['off']；null 剔除；xhigh/max 必须显式列出；off..high 无条件支持。
    const extendedLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    const expectLevels = (model: (typeof models)[number]): string[] => {
      if (!model.reasoning) return ['off'];
      return extendedLevels.filter((level) => {
        const mapped = model.thinkingLevelMap?.[level];
        if (mapped === null) return false;
        if (level === 'xhigh' || level === 'max') return mapped !== undefined;
        return true;
      });
    };

    for (const model of models) {
      expect(Array.isArray(model.availableThinkingLevels)).toBe(true);
      expect(model.availableThinkingLevels).toEqual(expectLevels(model));
    }
  });

  test('setSessionModel persists model_change into session file across runtime restore', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Persisted Model Test' });
    await client.restoreRuntime(created.sessionId, created.locator);

    const models = await client.listAvailableModels();
    const target = models.find((m) => !(created.model && m.provider === created.model.provider && m.id === created.model.id)) ?? models[0];
    expect(target).toBeTruthy();

    await client.setSessionModel(created.sessionId, created.locator, {
      provider: target.provider,
      id: target.id,
    });

    const persisted = SessionManager.open(created.locator.sessionFile).buildSessionContext().model;
    expect(persisted).toMatchObject({
      provider: target.provider,
      modelId: target.id,
    });

    await client.closeRuntime(created.sessionId);
    await client.restoreRuntime(created.sessionId, created.locator);

    expect(await client.getCurrentModel(created.sessionId)).toMatchObject({
      provider: target.provider,
      id: target.id,
    });
  });

  test('bindToolRuntime keeps the model restored from session file', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Bind Runtime Model Test' });
    await client.restoreRuntime(created.sessionId, created.locator);

    const models = await client.listAvailableModels();
    const target = models.at(-1) ?? models[0];
    expect(target).toBeTruthy();

    await client.setSessionModel(created.sessionId, created.locator, {
      provider: target.provider,
      id: target.id,
    });
    await client.closeRuntime(created.sessionId);

    await client.bindToolRuntime(
      created.sessionId,
      [
        {
          name: 'test_ping',
          description: 'Reply with pong',
          parameters: {
            type: 'object',
            properties: { message: { type: 'string' } },
            required: ['message'],
          },
        },
      ],
      async () => ({ pong: true }),
    );

    expect(await client.getCurrentModel(created.sessionId)).toMatchObject({
      provider: target.provider,
      id: target.id,
    });

    await client.closeRuntime(created.sessionId);
  });

  // ─── Stop session / error resilience ──────────────────────────────────────

  test('completeModel rejects unknown model', async () => {
    const client = createPiClient();
    await expect(client.completeModel({
      provider: 'no-such-provider-xyz',
      id: 'no-such-model',
      messages: [{ role: 'user', content: 'hi' }],
    })).rejects.toThrow(/model_not_found/);
  });

  test('stopSession returns stopped status for unknown session (never created)', async () => {
    const client = createPiClient();
    // Calling stopSession on a session-id that was never created must not throw
    // and must return { status: 'stopped' }.
    const result = await client.stopSession('never_created_session');
    expect(result).toMatchObject({ status: 'stopped' });
  });

  test('stopSession returns stopped status for session without runtime (restoreRuntime never called)', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Stop No Runtime Test' });
    // Created but never restored — agentSession is undefined.
    // stopSession must not throw and must return { status: 'stopped' }.
    const result = await client.stopSession(created.sessionId);
    expect(result).toMatchObject({ status: 'stopped' });
  });

  test('stopSession returns promptly for session with active runtime', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Stop Runtime Test' });
    await client.restoreRuntime(created.sessionId, created.locator);

    // Confirm the session has an agentSession (runtime is alive)
    // stopSession must NOT await abort() — it must return promptly.
    const start = performance.now();
    const result = await client.stopSession(created.sessionId);
    const elapsed = performance.now() - start;

    expect(result).toMatchObject({ status: 'stopped' });
    // If stopSession incorrectly awaits abort(), the runtime's prompt cycle could
    // block. Since we just restored (no streaming), the call should complete in
    // under 2 seconds.
    expect(elapsed).toBeLessThan(2000);
  });

  test('stopSession can be called twice (idempotent)', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Stop Idempotent Test' });

    const r1 = await client.stopSession(created.sessionId);
    expect(r1).toMatchObject({ status: 'stopped' });

    const r2 = await client.stopSession(created.sessionId);
    expect(r2).toMatchObject({ status: 'stopped' });
  });

  // ─── Runtime 回收机制修复回归测试（各测试独立 sessionId，不共享 registry 状态）───

  test('registerAgentStartSystemPrompt wires before_agent_start to append extra system prompt (chain, once per turn)', () => {
    // 白盒验证：ensureRuntime 的 extensionFactories 通过该 helper 把附加 systemPrompt
    // （如 ask_question 使用指引）注册为 before_agent_start 处理器。
    const extra = '使用 ask_question 工具向前端用户提问，选项 2-6 个。';
    const handlers: Array<(event: { systemPrompt: string }) => unknown> = [];
    const fakePi = {
      on(event: string, handler: (event: { systemPrompt: string }) => unknown) {
        handlers.push(handler);
      },
    } as never;

    registerAgentStartSystemPrompt(fakePi as any, extra);

    expect(handlers).toHaveLength(1);
    // 已有 base systemPrompt → 追加（SDK 每 turn 以 base 为输入，多次触发不会累积重复）
    expect(handlers[0]({ systemPrompt: 'base' })).toEqual({ systemPrompt: `base\n\n${extra}` });
    // 空 base → 直接返回附加文本
    expect(handlers[0]({ systemPrompt: '' })).toEqual({ systemPrompt: extra });
  });

  test('ensureRuntime with systemPrompt registers before_agent_start handler on live runtime', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'SystemPrompt Injection Test' });
    const extra = '附加指引：向用户提问前先使用 ask_question 确认。';

    await client.ensureRuntime('domain_session_sysprompt', {
      locator: created.locator,
      cwd: process.cwd(),
      tools: [{
        name: 'ask_question',
        description: '向用户提问',
        parameters: { type: 'object', properties: {} },
      }],
      toolHandler: async () => ({}),
      systemPrompt: extra,
    });

    // runtime 就绪且 extensionFactories 收到 systemPrompt（对 live agentSession 断言扩展已加载）
    expect(client.getRuntimeState('domain_session_sysprompt')?.ready).toBe(true);
    await client.closeRuntime('domain_session_sysprompt');
  });

  test('#5 ensureRuntime deletes piSessionId alias entry after prompt migration', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Alias Cleanup Test' });

    // domain sessionId 与 piSessionId 别名不同 → ensureRuntime 应迁移 prompt 并删除别名 entry
    await client.ensureRuntime('domain_session_alias', {
      locator: created.locator,
      cwd: process.cwd(),
      tools: [],
      toolHandler: async () => ({}),
    });

    // 别名 entry 已删除（修复前 getRuntimeState(created.sessionId) 会残留非 null）
    expect(client.getRuntimeState(created.sessionId)).toBeNull();
    // prompt 已迁移到 domain entry
    expect(client.getRuntimeState('domain_session_alias')?.prompt).toBe('hello');

    await client.closeRuntime('domain_session_alias');
  });

  test('#2 reloadIdleRuntimes disposes and clears agentSession (ready=false)', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Reload Idle Test' });
    // 生产路径：domain sessionId ≠ piSessionId 别名（locator.piSessionId 来自 createSession）
    await client.restoreRuntime('domain_session_reload', created.locator);
    expect(client.getRuntimeState('domain_session_reload')?.ready).toBe(true);

    await client.stopSession('domain_session_reload');
    const closed = await client.reloadIdleRuntimes();
    expect(closed).toBeGreaterThanOrEqual(1);

    // 修复点：dispose 后 agentSession 必须置空，否则 ready 仍为 true
    // （残留引用会让后续 run 对已 dispose 的 session 调 prompt() → 每次都失败）
    expect(client.getRuntimeState('domain_session_reload')?.ready).toBe(false);

    await client.closeRuntime('domain_session_reload');
  });

  test('#3 sendMessage resets stopped flag so reloadIdleRuntimes skips the session', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Stopped Reset Test' });
    await client.restoreRuntime('domain_session_reset', created.locator);

    await client.stopSession('domain_session_reset');
    // sendMessage 可能在模型无 key 时 reject——stopped 复位发生在 prompt 尝试之前，
    // 因此即使 run 失败，会话也已重新激活（不再被视为可回收）。
    await client.sendMessage('domain_session_reset', 'hi').catch(() => {});

    await client.reloadIdleRuntimes();
    // 本会话 stopped 已复位 → 不被 closeIdle 回收，runtime 保持存活
    expect(client.getRuntimeState('domain_session_reset')?.ready).toBe(true);

    await client.closeRuntime('domain_session_reset');
  });

  test('#1 closeRuntime skips streaming runtimes (isStreaming guard)', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Close Streaming Test' });
    await client.restoreRuntime(created.sessionId, created.locator);

    const p = client.sendMessage(created.sessionId, 'hi').catch(() => {});

    // 轮询等待 isStreaming 出现（模型无 key 时可能瞬间失败，超时则跳过第一段断言）
    let observed = false;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (client.getRuntimeState(created.sessionId)?.isStreaming) {
        observed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }

    if (observed && client.getRuntimeState(created.sessionId)?.isStreaming) {
      // 流式生成中调用 closeRuntime → 守卫生效，不得 dispose
      await client.closeRuntime(created.sessionId);
      expect(client.getRuntimeState(created.sessionId)?.ready).toBe(true);
    } else {
      console.log('[test] #1 streaming window not observed (model failed fast) — asserting dispose path only');
    }

    await p;
    // 生成结束后 closeRuntime 正常 dispose
    await client.closeRuntime(created.sessionId);
    expect(client.getRuntimeState(created.sessionId)?.ready).toBe(false);
  });

  test('waitForSessionIdle returns true immediately for unknown session without runtime', async () => {
    const client = createPiClient();
    const idle = await client.waitForSessionIdle('never_created_session', 1000);
    expect(idle).toBe(true);
  });
});

describe('mapAgentSessionEvent', () => {
  test('thinking delta → activity (safety timer reset signal)', () => {
    const event = mapAgentSessionEvent('sess_act_1', 'run_1', {
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'thinking...', partial: {} as never },
    });
    expect(event).toEqual({ type: 'activity', sessionId: 'sess_act_1', runId: 'run_1' });
  });

  test('tool_execution_start → activity (safety timer reset signal)', () => {
    const event = mapAgentSessionEvent('sess_act_2', 'run_2', {
      type: 'tool_execution_start',
      toolCallId: 'call_1',
      toolName: 'bash',
      args: { command: 'ls' },
    });
    expect(event).toEqual({ type: 'activity', sessionId: 'sess_act_2', runId: 'run_2' });
  });

  test('text_delta still maps to text_delta (regression)', () => {
    const event = mapAgentSessionEvent('sess_act_3', 'run_3', {
      type: 'message_update',
      message: {} as never,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'hello', partial: {} as never },
    });
    expect(event).toEqual({ type: 'text_delta', sessionId: 'sess_act_3', runId: 'run_3', delta: 'hello' });
  });

  test('unmapped events (agent_start) are dropped', () => {
    expect(mapAgentSessionEvent('sess_act_4', 'run_4', { type: 'agent_start' })).toBeNull();
  });
});
