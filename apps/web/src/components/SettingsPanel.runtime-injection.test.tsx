import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import SettingsPanel from './SettingsPanel';

// 设置面板「运行中允许插话（steer）」开关：默认关闭、反映服务端值、点击即自动保存。
// 与 SettingsPanel.timestamps.test.tsx 同一套 harness（全局 fetch 桩，不用 mock.module）。

const fetchState = {
  settings: {} as Record<string, string>,
  settingsPutBodies: [] as Array<Record<string, unknown>>,
  failSettingsPut: false,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalActEnv = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
const originalFetch = globalThis.fetch;

let window: Window;
let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  window = new Window({ url: 'https://demo.example.com/' });
  globalThis.window = window as unknown as Window & typeof globalThis;
  globalThis.document = window.document as unknown as Document;
  (globalThis as { navigator?: unknown }).navigator = window.navigator;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/v1/settings')) {
      if (method === 'PUT') {
        const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        fetchState.settingsPutBodies.push(patch);
        if (fetchState.failSettingsPut) {
          return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: '保存失败' } }, 400);
        }
        Object.assign(fetchState.settings, patch);
      }
      return jsonResponse({ ...fetchState.settings });
    }
    if (url.includes('/api/v1/role-templates')) return jsonResponse([]);
    if (url.includes('/api/v1/packages/updates')) return jsonResponse({ updates: [] });
    if (url.includes('/api/v1/packages')) return jsonResponse({ packages: [] });
    if (url.includes('/api/v1/models')) return jsonResponse({ models: [] });
    if (url.includes('/api/v1/auth/')) return jsonResponse({ requiresPassword: false, ok: true });
    return jsonResponse({});
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = originalActEnv;
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  fetchState.settings = {};
  fetchState.settingsPutBodies = [];
  fetchState.failSettingsPut = false;
});

const noopMut = { isPending: false, mutateAsync: async () => ({}) };

function props() {
  return {
    isOpen: true,
    onClose: () => {},
    sendShortcutMode: 'enter' as const,
    onSendShortcutModeChange: () => {},
    theme: 'system' as const,
    onThemeChange: () => {},
    systemNotificationsEnabled: false,
    onToggleSystemNotifications: async () => {},
    notificationPermissionStatus: 'granted',
    onOpenProviderModal: () => {},
    installPkgMut: noopMut,
    togglePkgMut: noopMut,
    removePkgMut: noopMut,
    updatePkgMut: noopMut,
    hideRoleLabels: false,
    onHideRoleLabelsChange: () => {},
    hiddenCompletedRoles: [],
    onHiddenCompletedRolesChange: () => {},
  };
}

async function renderPanel() {
  container = (globalThis.document as Document).createElement('div');
  (globalThis.document as Document).body.appendChild(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <SettingsPanel {...props()} />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const toggle = () => container!.querySelector('[data-testid="allow-runtime-injection-toggle"]') as HTMLInputElement;

async function clickToggle() {
  await act(async () => {
    toggle().click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('设置面板：运行中允许插话（steer）', () => {
  test('默认（服务端未设置）：开关关闭', async () => {
    await renderPanel();
    expect(toggle()).not.toBeNull();
    expect(toggle().checked).toBe(false);
  });

  test('服务端已开启：开关为选中', async () => {
    fetchState.settings = { allow_runtime_message_injection: 'true' };
    await renderPanel();
    expect(toggle().checked).toBe(true);
  });

  test('勾选后自动保存：PUT 请求体为字符串 true', async () => {
    await renderPanel();
    await clickToggle();
    expect(fetchState.settingsPutBodies).toEqual([{ allow_runtime_message_injection: 'true' }]);
    expect(toggle().checked).toBe(true);
  });

  test('取消勾选：PUT 请求体为字符串 false', async () => {
    fetchState.settings = { allow_runtime_message_injection: 'true' };
    await renderPanel();
    await clickToggle();
    expect(fetchState.settingsPutBodies).toEqual([{ allow_runtime_message_injection: 'false' }]);
    expect(toggle().checked).toBe(false);
  });

  test('保存失败：回滚到服务端值并提示', async () => {
    fetchState.settings = { allow_runtime_message_injection: 'false' };
    fetchState.failSettingsPut = true;
    await renderPanel();
    await clickToggle();
    expect(toggle().checked).toBe(false);
    expect(container!.textContent).toContain('保存失败');
  });
});
