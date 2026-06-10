const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(hostname: string) {
  return LOOPBACK_HOSTS.has(hostname);
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function inferApiPortFromCurrentPort(currentPort: string) {
  const port = Number(currentPort);
  if (!Number.isFinite(port) || port <= 0) {
    return '3001';
  }
  return String(port + 1);
}

export function getApiBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_API_BASE_URL;
  const explicitPort = process.env.NEXT_PUBLIC_API_PORT;

  if (typeof window !== 'undefined') {
    const current = new URL(window.location.href);

    if (explicit) {
      const parsed = safeUrl(explicit);
      if (parsed) {
        if (isLoopbackHost(parsed.hostname) && !isLoopbackHost(current.hostname)) {
          return `${current.protocol}//${current.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
        }
        return parsed.toString().replace(/\/$/, '');
      }
    }

    const apiPort = explicitPort || inferApiPortFromCurrentPort(current.port);
    return `${current.protocol}//${current.hostname}:${apiPort}`;
  }

  return (explicit ?? 'http://localhost:3001').replace(/\/$/, '');
}

export function getWsBaseUrl() {
  const explicit = process.env.NEXT_PUBLIC_WS_BASE_URL;
  const apiBase = getApiBaseUrl();

  if (typeof window !== 'undefined') {
    const current = new URL(window.location.href);

    if (explicit) {
      const parsed = safeUrl(explicit);
      if (parsed) {
        if (isLoopbackHost(parsed.hostname) && !isLoopbackHost(current.hostname)) {
          const protocol = current.protocol === 'https:' ? 'wss:' : 'ws:';
          return `${protocol}//${current.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
        }
        return parsed.toString().replace(/\/$/, '');
      }
    }
  }

  return apiBase.replace(/^http/i, 'ws');
}
