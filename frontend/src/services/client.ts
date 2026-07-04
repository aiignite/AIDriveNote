import { keysToCamel, keysToSnake } from '../utils/caseConverter';

export const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

const TOKEN_KEY = 'aidrivenote.access_token';
const REFRESH_KEY = 'aidrivenote.refresh_token';

let accessToken: string | null =
  typeof window !== 'undefined' ? window.localStorage.getItem(TOKEN_KEY) : null;

export function setAuthTokens(tokens: {
  accessToken: string | null;
  refreshToken?: string | null;
}) {
  accessToken = tokens.accessToken;
  if (typeof window === 'undefined') return;
  if (tokens.accessToken) {
    window.localStorage.setItem(TOKEN_KEY, tokens.accessToken);
  } else {
    window.localStorage.removeItem(TOKEN_KEY);
  }
  if (tokens.refreshToken) {
    window.localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
  } else if (tokens.accessToken === null) {
    window.localStorage.removeItem(REFRESH_KEY);
  }
}

export function getToken() {
  return accessToken;
}

export function isAuthenticated() {
  return !!accessToken;
}

export type QueryValue = string | number | boolean | undefined | null;

export function buildQuery(params?: Record<string, QueryValue | unknown>) {
  if (!params) return '';
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    if (typeof value === 'object') return;
    query.set(key, String(value));
  });
  const qs = query.toString();
  return qs ? `?${qs}` : '';
}

function resolveUrl(path: string) {
  if (path.startsWith('http')) return path;
  return `${API_BASE}${path}`;
}

async function refreshAccessToken(): Promise<boolean> {
  const refresh = typeof window !== 'undefined'
    ? window.localStorage.getItem(REFRESH_KEY)
    : null;
  if (!refresh) return false;
  try {
    const res = await fetch(resolveUrl('/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!res.ok) return false;
    const data = keysToCamel<{ accessToken: string }>(await res.json());
    if (!data.accessToken) return false;
    setAuthTokens({ accessToken: data.accessToken, refreshToken: refresh });
    return true;
  } catch {
    return false;
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  retried = false,
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(resolveUrl(path), { ...options, headers });

  if (res.status === 401 && !retried && !path.includes('/auth/')) {
    const ok = await refreshAccessToken();
    if (ok) return request(path, options, true);
    setAuthTokens({ accessToken: null });
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    throw new Error('Unauthorized');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  if (!res.ok) {
    let detail = text;
    try {
      detail = JSON.parse(text)?.detail ?? text;
    } catch { /* ignore */ }
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }

  if (!text) return undefined as T;
  return keysToCamel(JSON.parse(text)) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(keysToSnake(body)) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(keysToSnake(body)) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PUT', body: body ? JSON.stringify(keysToSnake(body)) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
