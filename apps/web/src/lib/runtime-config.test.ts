import { afterEach, describe, expect, test } from 'bun:test';
import { getApiBaseUrl, getWsBaseUrl } from './runtime-config';

describe('runtime config', () => {
  const originalWindow = globalThis.window;
  const originalApi = import.meta.env.VITE_API_BASE_URL;
  const originalWs = import.meta.env.VITE_WS_BASE_URL;

  afterEach(() => {
    globalThis.window = originalWindow;
    import.meta.env.VITE_API_BASE_URL = originalApi;
    import.meta.env.VITE_WS_BASE_URL = originalWs;
  });

  test('uses vite env api and ws base urls when provided', () => {
    globalThis.window = {
      location: {
        protocol: 'https:',
        host: 'current.example.com',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;

    import.meta.env.VITE_API_BASE_URL = 'https://public.example.com/';
    import.meta.env.VITE_WS_BASE_URL = 'wss://public.example.com/';

    expect(getApiBaseUrl()).toBe('https://public.example.com');
    expect(getWsBaseUrl()).toBe('wss://public.example.com');
  });

  test('falls back to browser websocket origin when vite ws env is absent', () => {
    globalThis.window = {
      location: {
        protocol: 'https:',
        host: 'current.example.com',
      },
      piplusConfig: {},
    } as Window & typeof globalThis;

    import.meta.env.VITE_API_BASE_URL = '';
    import.meta.env.VITE_WS_BASE_URL = '';

    expect(getApiBaseUrl()).toBe('');
    expect(getWsBaseUrl()).toBe('wss://current.example.com');
  });
});
