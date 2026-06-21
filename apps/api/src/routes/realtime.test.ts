import { afterEach, describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';
import { socketHub } from '../ws/server';

type MockSocket = {
  sent: string[];
  send(data: string): void;
};

function makeDbPath(label: string) {
  return `/tmp/piplus-${label}-${crypto.randomUUID()}.sqlite`;
}

function createMockSocket(): MockSocket {
  return {
    sent: [],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

let attached: MockSocket[] = [];

afterEach(() => {
  for (const socket of attached) {
    socketHub.detach(socket as never);
  }
  attached = [];
});

describe('realtime route emissions', () => {
  test('project and top-level session creation emits control-plane events', async () => {
    const path = makeDbPath('realtime-project');
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();
    const socket = createMockSocket();
    attached.push(socket);
    socketHub.attach(socket as never);

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Realtime Project', mode: 'existing', path: '/tmp' }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();

    const blankRes = await app.request(`/api/v1/projects/${projectBody.projectId}/sessions`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(blankRes.status).toBe(201);

    const messages = socket.sent.map((raw) => JSON.parse(raw) as { kind: string; type: string; scope?: { project_id?: string; session_id?: string } });
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'project.created' && msg.scope?.project_id === projectBody.projectId)).toBe(true);
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'session.created' && msg.scope?.session_id === projectBody.sessionId)).toBe(true);
    expect(messages.filter((msg) => msg.kind === 'event' && msg.type === 'tree.changed' && msg.scope?.project_id === projectBody.projectId).length).toBeGreaterThanOrEqual(2);
  });

  test('chat send and archive emit realtime frames for the active session', async () => {
    const path = makeDbPath('realtime-session');
    createSeedDb(path);
    Bun.env.DATABASE_URL = `file:${path}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Realtime Session Project', mode: 'existing', path: '/tmp' }),
    });
    const projectBody = await projectRes.json();

    const socket = createMockSocket();
    attached.push(socket);
    socketHub.attach(socket as never);
    socketHub.setContext(socket as never, {
      project_id: projectBody.projectId,
      session_id: projectBody.sessionId,
      current_tab: 'chat',
    });

    const sendRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/chat/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ content: 'hello realtime' }),
    });
    expect(sendRes.status).toBe(202);

    const archiveRes = await app.request(`/api/v1/sessions/${projectBody.sessionId}/archive`, {
      method: 'POST',
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(archiveRes.status).toBe(200);

    const messages = socket.sent.map((raw) => JSON.parse(raw) as { kind: string; type?: string; phase?: string; scope?: { session_id?: string; project_id?: string } });
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'session.runtime_status_changed' && msg.scope?.session_id === projectBody.sessionId)).toBe(true);
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'session.archived' && msg.scope?.session_id === projectBody.sessionId)).toBe(true);
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'tree.changed' && msg.scope?.project_id === projectBody.projectId)).toBe(true);
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'session.archived' && msg.scope?.session_id === projectBody.sessionId)).toBe(true);
    expect(messages.some((msg) => msg.kind === 'event' && msg.type === 'tree.changed' && msg.scope?.project_id === projectBody.projectId)).toBe(true);
  });
});
