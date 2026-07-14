import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';

describe('createApp docker serving', () => {
  const originalOrigin = process.env.PUBLIC_WEB_ORIGIN;
  const originalCorsOrigins = process.env.CORS_ORIGINS;
  const originalServeWeb = process.env.PIPLUS_SERVE_WEB;
  const originalWebDist = process.env.PIPLUS_WEB_DIST;

  afterEach(() => {
    process.env.PUBLIC_WEB_ORIGIN = originalOrigin;
    process.env.CORS_ORIGINS = originalCorsOrigins;
    process.env.PIPLUS_SERVE_WEB = originalServeWeb;
    process.env.PIPLUS_WEB_DIST = originalWebDist;
  });

  test('returns configured cors origin for api responses', async () => {
    process.env.PUBLIC_WEB_ORIGIN = 'https://demo.example.com';
    const app = createApp();

    const response = await app.request('/health', {
      headers: { Origin: 'https://demo.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).toBe('https://demo.example.com');
  });

  test('does not allow a non-matching cors origin when public origin is configured', async () => {
    process.env.PUBLIC_WEB_ORIGIN = 'https://demo.example.com';
    const app = createApp();

    const response = await app.request('/health', {
      headers: { Origin: 'https://other.example.com' },
    });

    expect(response.headers.get('access-control-allow-origin')).not.toBe('https://other.example.com');
  });

  test('serves index html with runtime config injection for non-api routes', async () => {
    const webDist = join(tmpdir(), `piplus-web-${Date.now()}`);
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><head></head><body>Piplus</body></html>');

    process.env.PUBLIC_WEB_ORIGIN = 'https://demo.example.com';
    process.env.PIPLUS_SERVE_WEB = '1';
    process.env.PIPLUS_WEB_DIST = webDist;

    const app = createApp();
    const response = await app.request('/projects/123');
    const body = await response.text();

    rmSync(webDist, { recursive: true, force: true });

    expect(response.status).toBe(200);
    expect(body).toContain('Piplus');
    expect(body).toContain('window.piplusConfig');
    expect(body).toContain('apiBaseUrl:"https://demo.example.com"');
    expect(body).toContain('wsBaseUrl:"wss://demo.example.com"');
  });

  test('derives ws protocol from http origin', async () => {
    const webDist = join(tmpdir(), `piplus-web-${Date.now()}-http`);
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><head></head><body></body></html>');

    process.env.PUBLIC_WEB_ORIGIN = 'http://internal.example.com';
    process.env.PIPLUS_SERVE_WEB = '1';
    process.env.PIPLUS_WEB_DIST = webDist;

    const app = createApp();
    const response = await app.request('/');
    const body = await response.text();

    rmSync(webDist, { recursive: true, force: true });

    expect(body).toContain('apiBaseUrl:"http://internal.example.com"');
    expect(body).toContain('wsBaseUrl:"ws://internal.example.com"');
  });

  test('accepts plain domain as https origin', async () => {
    const webDist = join(tmpdir(), `piplus-web-${Date.now()}-plain`);
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><head></head><body></body></html>');

    process.env.PUBLIC_WEB_ORIGIN = 'piplus.whosworld.fun';
    process.env.PIPLUS_SERVE_WEB = '1';
    process.env.PIPLUS_WEB_DIST = webDist;

    const app = createApp();

    // CORS should use normalized https
    const corsRes = await app.request('/health', {
      headers: { Origin: 'https://piplus.whosworld.fun' },
    });
    expect(corsRes.headers.get('access-control-allow-origin')).toBe('https://piplus.whosworld.fun');

    // SPA fallback should inject config with https:// and wss://
    const spaRes = await app.request('/projects/123');
    const body = await spaRes.text();

    rmSync(webDist, { recursive: true, force: true });

    expect(body).toContain('apiBaseUrl:"https://piplus.whosworld.fun"');
    expect(body).toContain('wsBaseUrl:"wss://piplus.whosworld.fun"');
  });

  test('serves spa fallback without config when PUBLIC_WEB_ORIGIN is unset', async () => {
    const webDist = join(tmpdir(), `piplus-web-${Date.now()}-noorigin`);
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><head></head><body>Piplus</body></html>');

    process.env.PUBLIC_WEB_ORIGIN = '';
    process.env.PIPLUS_SERVE_WEB = '1';
    process.env.PIPLUS_WEB_DIST = webDist;

    const app = createApp();
    const response = await app.request('/projects/123');
    const body = await response.text();

    rmSync(webDist, { recursive: true, force: true });

    expect(response.status).toBe(200);
    expect(body).toContain('Piplus');
    expect(body).not.toContain('window.piplusConfig');
  });

  test('does not serve spa fallback for health route', async () => {
    const webDist = join(tmpdir(), `piplus-web-${Date.now()}-health`);
    mkdirSync(webDist, { recursive: true });
    writeFileSync(join(webDist, 'index.html'), '<html><head></head><body>Piplus</body></html>');

    process.env.PIPLUS_SERVE_WEB = '1';
    process.env.PIPLUS_WEB_DIST = webDist;

    const app = createApp();
    const response = await app.request('/health');
    const body = await response.text();

    rmSync(webDist, { recursive: true, force: true });

    expect(response.status).toBe(200);
    expect(body).toContain('{"ok":true}');
  });
});

describe('CORS_ORIGINS env var', () => {
  const originalCorsOrigins = process.env.CORS_ORIGINS;
  const originalOrigin = process.env.PUBLIC_WEB_ORIGIN;

  afterEach(() => {
    process.env.CORS_ORIGINS = originalCorsOrigins;
    process.env.PUBLIC_WEB_ORIGIN = originalOrigin;
  });

  test('CORS_ORIGINS with multiple origins allows all configured origins', async () => {
    process.env.CORS_ORIGINS = 'https://app1.example.com,https://app2.example.com';
    const app = createApp();

    const res1 = await app.request('/health', {
      headers: { Origin: 'https://app1.example.com' },
    });
    const res2 = await app.request('/health', {
      headers: { Origin: 'https://app2.example.com' },
    });

    expect(res1.headers.get('access-control-allow-origin')).toBe('https://app1.example.com');
    expect(res2.headers.get('access-control-allow-origin')).toBe('https://app2.example.com');
  });

  test('CORS_ORIGINS with multiple origins rejects non-matching origin', async () => {
    process.env.CORS_ORIGINS = 'https://app1.example.com,https://app2.example.com';
    const app = createApp();

    const res = await app.request('/health', {
      headers: { Origin: 'https://evil.example.com' },
    });

    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example.com');
  });

  test('CORS_ORIGINS=* allows any origin', async () => {
    process.env.CORS_ORIGINS = '*';
    const app = createApp();

    const res = await app.request('/health', {
      headers: { Origin: 'https://random.example.com' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('https://random.example.com');
  });

  test('CORS_ORIGINS takes priority over PUBLIC_WEB_ORIGIN', async () => {
    process.env.CORS_ORIGINS = 'https://app1.example.com';
    process.env.PUBLIC_WEB_ORIGIN = 'https://old.example.com';
    const app = createApp();

    // CORS_ORIGINS origin should work
    const resCors = await app.request('/health', {
      headers: { Origin: 'https://app1.example.com' },
    });
    expect(resCors.headers.get('access-control-allow-origin')).toBe('https://app1.example.com');

    // PUBLIC_WEB_ORIGIN origin should be rejected when CORS_ORIGINS is set
    const resPublic = await app.request('/health', {
      headers: { Origin: 'https://old.example.com' },
    });
    expect(resPublic.headers.get('access-control-allow-origin')).not.toBe('https://old.example.com');
  });

  test('CORS_ORIGINS="" falls back to PUBLIC_WEB_ORIGIN', async () => {
    process.env.CORS_ORIGINS = '';
    process.env.PUBLIC_WEB_ORIGIN = 'https://demo.example.com';
    const app = createApp();

    const res = await app.request('/health', {
      headers: { Origin: 'https://demo.example.com' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('https://demo.example.com');
  });

  test('CORS_ORIGINS="," (only commas) falls back to allow all', async () => {
    process.env.CORS_ORIGINS = ',';
    process.env.PUBLIC_WEB_ORIGIN = '';
    const app = createApp();

    const res = await app.request('/health', {
      headers: { Origin: 'https://any.example.com' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('https://any.example.com');
  });

  test('returns cors origin for request without origin header', async () => {
    process.env.CORS_ORIGINS = 'https://app1.example.com';
    const app = createApp();

    const res = await app.request('/health');

    expect(res.headers.get('access-control-allow-origin')).toBe('https://app1.example.com');
  });

  test('neither CORS_ORIGINS nor PUBLIC_WEB_ORIGIN allows all', async () => {
    delete process.env.CORS_ORIGINS;
    delete process.env.PUBLIC_WEB_ORIGIN;
    const app = createApp();

    const res = await app.request('/health', {
      headers: { Origin: 'https://any.example.com' },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe('https://any.example.com');
  });
});
