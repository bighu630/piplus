import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app';

describe('createApp docker serving', () => {
  const originalOrigin = process.env.PUBLIC_WEB_ORIGIN;
  const originalServeWeb = process.env.PIPLUS_SERVE_WEB;
  const originalWebDist = process.env.PIPLUS_WEB_DIST;

  afterEach(() => {
    process.env.PUBLIC_WEB_ORIGIN = originalOrigin;
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
