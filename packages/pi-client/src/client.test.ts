import { SessionManager } from '@earendil-works/pi-coding-agent';
import { describe, expect, test } from 'bun:test';
import { createPiClient } from './client';

describe('pi client gateway', () => {
  test('createSession returns a persistent pi session locator path', async () => {
    const client = createPiClient();
    const result = await client.createSession({ prompt: 'hello', title: 'Test' });
    expect(result.locator.sessionFile).toBeTruthy();
    expect(result.locator.sessionFile).toContain('/.pi/agent/sessions/');
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

  test('setSessionModel switches the model for the current session', async () => {
    const client = createPiClient();
    const created = await client.createSession({ prompt: 'hello', title: 'Model Test' });
    await client.restoreRuntime(created.sessionId, created.locator);
    const models = await client.listAvailableModels();
    const target = models[0];
    const result = await client.setSessionModel(created.sessionId, created.locator, {
      provider: target.provider,
      id: target.id,
    });
    expect(result.provider).toBe(target.provider);
    expect(result.id).toBe(target.id);
  });
});

