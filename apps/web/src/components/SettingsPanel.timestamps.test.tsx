import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Window } from 'happy-dom';
import SettingsPanel from './SettingsPanel';

// 设置面板「隐藏对话框时间戳」开关：反映服务端值、点击即自动保存（无需额外保存按钮）。
//
// 注意：这里刻意不使用 mock.module —— bun 会在运行测试前加载所有测试文件的模块图，
// 顶层 mock 会跨文件泄漏（实测会破坏 ws-provider.test.tsx 的 4 个用例）。
// 改用全局 fetch 桩：/api/v1/settings 的 GET/PUT 走内存状态，其余端点返回空数据，
// 这样点击开关会真实走 api.ts → fetch 链路，断言请求体即可验证自动保存。

const fetchState = {
  settings: {} as Record<string, string>,
  settingsPutBodies: [] as Array<Record<string, unknown>>,
  failSettingsPut: false,
  hangSettingsPut: false,
};

/** 挂起的 PUT：用于验证乐观更新（点击后立即翻转，不等服务端返回） */
const pendingPutResolvers: Array<() => void> = [];
const releasePendingPut = () => {
  while (pendingPutResolvers.length > 0) pendingPutResolvers.shift()!();
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
        if (fetchState.hangSettingsPut) {
          await new Promise<void>((resolve) => {
            pendingPutResolvers.push(resolve);
          });
        }
        const patch = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        fetchState.settingsPutBodies.push(patch);
        if (fetchState.failSettingsPut) {
          return jsonResponse({ error: { code: 'VALIDATION_ERROR', message: '保存失败：网络错误' } }, 400);
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
  // 释放可能挂起的 PUT，避免影响下一个用例
  releasePendingPut();
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
  fetchState.hangSettingsPut = false;
});

const noopMut = { isPending: false, mutateAsync: async () => ({}) };

function props() {
  return {
    isOpen: true,
    onClose: () => {},
    sendShortcutMode: 'enter',
    onSendShortcutModeChange: () => {},
    theme: 'system',
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
  // 等 settings 等 query 的 fetch → json() 微任务链完成，再断言受服务端值控制的开关状态
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const toggle = () => container!.querySelector('[data-testid="hide-chat-timestamps-toggle"]') as HTMLInputElement;

/** 点击开关并等待 PUT → invalidate → 重新 GET 的完整链路落定 */
async function clickToggle() {
  await act(async () => {
    toggle().click();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('设置面板：隐藏对话框时间戳', () => {
  test('默认（服务端未设置）：开关关闭', async () => {
    await renderPanel();
    expect(toggle()).not.toBeNull();
    expect(toggle().checked).toBe(false);
  });

  test('服务端已开启：开关为选中', async () => {
    fetchState.settings = { hide_chat_timestamps: 'true' };
    await renderPanel();
    expect(toggle().checked).toBe(true);
  });

  test('勾选后自动保存：PUT 请求体为字符串 true', async () => {
    await renderPanel();
    await clickToggle();
    expect(fetchState.settingsPutBodies).toEqual([{ hide_chat_timestamps: 'true' }]);
    // 保存后回读：开关保持选中（设置即时生效链路的一部分）
    expect(toggle().checked).toBe(true);
  });

  test('取消勾选：PUT 请求体为字符串 false', async () => {
    fetchState.settings = { hide_chat_timestamps: 'true' };
    await renderPanel();
    await clickToggle();
    expect(fetchState.settingsPutBodies).toEqual([{ hide_chat_timestamps: 'false' }]);
    expect(toggle().checked).toBe(false);
  });

  test('乐观更新：PUT 未返回时开关已立即翻转（不弹回）', async () => {
    fetchState.hangSettingsPut = true;
    await renderPanel();
    await act(async () => {
      toggle().click();
    });
    // 服务端还没返回，但开关已经生效
    expect(toggle().checked).toBe(true);

    // 放行 PUT：服务端值追上乐观值，开关保持选中
    await act(async () => {
      releasePendingPut();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(toggle().checked).toBe(true);
  });

  test('保存失败：显示错误提示，且开关回滚到服务端值', async () => {
    fetchState.failSettingsPut = true;
    await renderPanel();
    // 点击瞬间乐观选中
    await act(async () => {
      toggle().click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container!.textContent).toContain('保存失败：网络错误');
    expect(toggle().checked).toBe(false);
  });
});
