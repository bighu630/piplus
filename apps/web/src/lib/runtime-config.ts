export type PiplusRuntimeConfig = {
  isDesktop?: boolean;
  platform?: string;
  apiBaseUrl?: string;
  wsBaseUrl?: string;
};

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

function normalizeOptionalBaseUrl(value?: string | null) {
  if (!value) return undefined;
  const normalized = trimTrailingSlash(value.trim());
  return normalized || undefined;
}

function getBrowserDefaultWsBaseUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

export function getRuntimeConfig(): PiplusRuntimeConfig {
  if (typeof window === 'undefined') {
    return {};
  }

  return window.piplusConfig ?? {};
}

function getEnvBaseUrl(key: 'VITE_API_BASE_URL' | 'VITE_WS_BASE_URL') {
  const value = import.meta.env[key];
  return normalizeOptionalBaseUrl(value);
}

export function getApiBaseUrl() {
  const config = getRuntimeConfig();
  return normalizeOptionalBaseUrl(config.apiBaseUrl) ?? getEnvBaseUrl('VITE_API_BASE_URL') ?? '';
}

export function getWsBaseUrl() {
  const config = getRuntimeConfig();
  return normalizeOptionalBaseUrl(config.wsBaseUrl)
    ?? getEnvBaseUrl('VITE_WS_BASE_URL')
    ?? getBrowserDefaultWsBaseUrl();
}
