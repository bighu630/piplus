import { SessionManager } from '@earendil-works/pi-coding-agent';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test } from 'bun:test';
import { createPiClient } from './client';

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

  test('sendMessage persists conversation to pi session history after runtime is closed', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Send Test' });

    await client.restoreRuntime(created.sessionId, created.locator);
    const run = await client.sendMessage(created.sessionId, 'Reply with exactly: persist me');

    expect(run.sessionId).toBe(created.sessionId);
    expect(run.runId).toBeTruthy();

    await client.closeRuntime(created.sessionId);

    const page = await client.getHistory(created.sessionId, created.locator, null, 20);
    expect(page.messages[0]?.role).toBe('user');
    expect(page.messages[0]?.text).toBe('Reply with exactly: persist me');
    expect(page.messages.at(-1)?.role).toBe('assistant');
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

});
