export function getApiBaseUrl() {
  if (typeof window !== 'undefined') {
    return ''; // Vite proxy handles /api prefix
  }
  return 'http://localhost:3011';
}

export function getWsBaseUrl() {
  if (typeof window !== 'undefined') {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}`;
  }
  return 'ws://localhost:3011';
}
