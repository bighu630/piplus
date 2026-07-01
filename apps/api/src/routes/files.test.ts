import { describe, expect, test } from 'bun:test';
import { createSeedDb } from '@piplus/db/init';
import { createApp } from '../app';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';

function makeDbPath() {
  return `/tmp/piplus-files-test-${crypto.randomUUID()}.sqlite`;
}

function makeProjectDir() {
  return `/tmp/piplus-files-project-${crypto.randomUUID()}`;
}

const TEST_FILE_SIZE_LIMIT = 1024 * 1024; // 1MB, matches MAX_FILE_WRITE_BYTES

describe('file content save route', () => {
  test('save file content and verify via GET', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    // Create a project pointing to our temp dir
    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Files Test Project', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Create a test file
    const testFilePath = 'test-hello.txt';
    await writeFile(path.join(projectDir, testFilePath), 'original content', 'utf8');

    // Save new content via PUT
    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: testFilePath, content: 'updated content v2' }),
    });
    expect(saveRes.status).toBe(200);
    const saveBody = await saveRes.json();
    expect(saveBody).toHaveProperty('session_id', sessionId);
    expect(saveBody).toHaveProperty('path', testFilePath);
    expect(saveBody).toHaveProperty('size', 18); // 'updated content v2'.length

    // Verify via GET
    const getRes = await app.request(`/api/v1/sessions/${sessionId}/files/content?path=${encodeURIComponent(testFilePath)}`, {
      headers: { 'x-user-id': 'user_seed' },
    });
    expect(getRes.status).toBe(200);
    const getBody = await getRes.json();
    expect(getBody.content).toBe('updated content v2');
    expect(getBody.truncated).toBe(false);

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('path traversal returns 400', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Traversal Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Path traversal attempt
    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: '../evil.txt', content: 'malicious' }),
    });
    expect(saveRes.status).toBe(400);
    const body = await saveRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('INVALID_PATH');

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('writing to a directory returns 400', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    await mkdir(path.join(projectDir, 'subdir'), { recursive: true });
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Dir Write Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: 'subdir', content: 'content for a directory' }),
    });
    expect(saveRes.status).toBe(400);
    const body = await saveRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('IS_DIRECTORY');

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('content exceeding size limit returns 413', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Size Limit Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Create a test file first
    await writeFile(path.join(projectDir, 'large.txt'), 'original', 'utf8');

    // Content that exceeds 1MB
    const oversized = 'x'.repeat(TEST_FILE_SIZE_LIMIT + 1);
    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: 'large.txt', content: oversized }),
    });
    expect(saveRes.status).toBe(413);
    const body = await saveRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('CONTENT_TOO_LARGE');

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('non-text file extension returns 400', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Non-Text Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Create a binary file
    await writeFile(path.join(projectDir, 'image.png'), 'fake-png-content', 'utf8');

    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: 'image.png', content: 'text content' }),
    });
    expect(saveRes.status).toBe(400);
    const body = await saveRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('UNSUPPORTED_FILE');

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('empty path returns 400', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Empty Path Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: '', content: 'some content' }),
    });
    expect(saveRes.status).toBe(400);

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('writing to .git directory returns 400', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(path.join(projectDir, '.git'), { recursive: true });
    await writeFile(path.join(projectDir, '.git', 'config'), 'original', 'utf8');
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Git Ignored Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: '.git/config', content: 'modified' }),
    });
    expect(saveRes.status).toBe(400);
    const body = await saveRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('INVALID_PATH');

    // Verify file was not modified
    const fileContent = await Bun.file(path.join(projectDir, '.git', 'config')).text();
    expect(fileContent).toBe('original');

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });

  test('non-string content returns 400', async () => {
    const dbPath = makeDbPath();
    const projectDir = makeProjectDir();
    createSeedDb(dbPath);
    await mkdir(projectDir, { recursive: true });
    await writeFile(path.join(projectDir, 'test.txt'), 'original', 'utf8');
    Bun.env.DATABASE_URL = `file:${dbPath}`;
    const app = createApp();

    const projectRes = await app.request('/api/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ name: 'Non-String Content Test', mode: 'existing', path: projectDir }),
    });
    expect(projectRes.status).toBe(201);
    const projectBody = await projectRes.json();
    const sessionId = projectBody.sessionId as string;

    // Send numeric content
    const saveRes = await app.request(`/api/v1/sessions/${sessionId}/files/content`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-user-id': 'user_seed' },
      body: JSON.stringify({ path: 'test.txt', content: 123 }),
    });
    expect(saveRes.status).toBe(400);
    const body = await saveRes.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('INVALID_CONTENT');

    // Cleanup
    await rm(projectDir, { recursive: true, force: true });
  });
});
