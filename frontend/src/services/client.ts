import type { AuthUser } from './auth';
import { keysToCamel, keysToSnake } from '../utils/caseConverter';
import { clearAllUnlock } from './note/unlockStore';

export const API_BASE = import.meta.env.VITE_API_URL ?? '/api/v1';

const TOKEN_KEY = 'aidrivenote.access_token';
const REFRESH_KEY = 'aidrivenote.refresh_token';
const USER_KEY = 'aidrivenote.user';

/**
 * 网络不可达错误。
 * 用于把「请求根本没发出去 / 没有响应」与「服务端明确答复失败」区分开：
 * 离线降级逻辑只应针对前者触发，绝不能把 401 鉴权失败也当作离线，
 * 否则登录态失效会被静默掩盖。
 */
export class NetworkError extends Error {
  constructor(message = '网络不可达') {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * 判断异常是否属于网络不可达。
 * @param err 捕获到的异常
 * @returns 是否为 NetworkError
 */
export function isNetworkError(err: unknown): err is NetworkError {
  return err instanceof NetworkError;
}

/**
 * 判断浏览器是否处于离线状态。
 * 仅作为辅助信号：navigator.onLine 为 true 不代表目标服务一定可达。
 * @returns 是否离线
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * 清除本地离线缓存（IndexedDB）。
 * 登出或鉴权失效时必须调用，避免同一浏览器切换账号后读到上一个用户的数据。
 * 使用动态 import 让 offline 模块不进入首屏关键路径，也避免与 client 形成静态循环依赖。
 */
function clearOfflineData(): void {
  void import('./offline/offlineDb')
    .then((mod) => mod.clearAll())
    .catch(() => { /* 离线库不可用（隐私模式等）时忽略 */ });
}

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
    // 登出 / 401 失效：快照必须一并清除，避免下次打开误判为已登录
    writeCachedUser(null);
    // 离线缓存同样要清，否则换账号登录会读到上一个用户的笔记
    clearOfflineData();
    // 加密文档的解锁票据也必须在登出时清空，避免会话残留导致越权读取
    clearAllUnlock();
  }
}

/**
 * 读取本地用户快照，用于首屏秒开。
 * 让应用在等待后台 /auth/me 校验期间就能渲染页面框架与发起数据请求。
 * 解析失败或缺少关键字段时返回 null，由后台校验兜底。
 */
export function readCachedUser(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthUser> | null;
    if (!parsed?.id || !parsed?.email) return null;
    return {
      id: String(parsed.id),
      email: String(parsed.email),
      name: String(parsed.name ?? ''),
      status: String(parsed.status ?? ''),
      role: String(parsed.role ?? ''),
      // 匿名标记必须随快照保留：首屏据此决定隐藏哪些入口，
      // 若丢失会在后台校验返回前短暂显示普通用户的全部菜单
      isGuest: parsed.isGuest === true,
    };
  } catch {
    return null;
  }
}

/**
 * 写入或清除用户快照。
 * @param user 传 null 表示清除（登出、鉴权失效、快照过期）
 */
export function writeCachedUser(user: AuthUser | null) {
  if (typeof window === 'undefined') return;
  try {
    if (user) {
      window.localStorage.setItem(USER_KEY, JSON.stringify(user));
    } else {
      window.localStorage.removeItem(USER_KEY);
    }
  } catch {
    /* localStorage 不可用（隐私模式 / 配额）时忽略，不影响主流程 */
  }
}

export function getToken() {
  return accessToken;
}

export function isAuthenticated() {
  return !!accessToken;
}

/** SSO: portal may authenticate via HttpOnly cookie without localStorage token. */
export function mayHaveSession() {
  return true;
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

/**
 * 把后端返回的资源直链（图片资产 / 录音音频等）改写为当前部署可访问的地址。
 *
 * 后端正文里存的是根绝对路径（如 /api/v1/notes/assets/{hash}.jpg），子路径部署
 * （VITE_BASE_PATH=/note/）下 <img>/<audio> 直接用它会被外层 nginx 判 404，
 * 因为只有 /note/api/ 有路由。这里按部署前缀改写；已是绝对地址或 data URL 的
 * 原样返回，幂等可重复调用。
 */
export function resolveAssetUrl(url: string): string {
  const raw = (url || '').trim();
  if (!raw || /^(https?:|data:|blob:)/i.test(raw) || !raw.startsWith('/api/')) return raw;
  if (/^https?:/i.test(API_BASE)) {
    // 跨域直连后端时按 API_BASE 解析出正确 origin
    try {
      return new URL(raw, API_BASE).toString();
    } catch {
      return raw;
    }
  }
  const base = (import.meta.env.BASE_URL ?? '/').replace(/\/+$/, '');
  return base ? `${base}${raw}` : raw;
}

async function performRefresh(): Promise<boolean> {
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

/** 续期中的共享 Promise：把并发的 401 收敛成一次续期请求 */
let refreshInFlight: Promise<boolean> | null = null;

/**
 * 续期访问令牌。
 *
 * 并发调用共享同一个 in-flight 请求：首屏会同时发出 notes / folders / tags /
 * ai-settings 等多个接口，若各自独立续期，会在同一瞬间打出 N 个
 * `/auth/refresh`（服务端日志里能看到成组出现），既浪费也可能互相覆盖令牌。
 * @returns 是否续期成功
 */
function refreshAccessToken(): Promise<boolean> {
  if (!refreshInFlight) {
    refreshInFlight = performRefresh().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
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

  let res: Response;
  try {
    res = await fetch(resolveUrl(path), { ...options, headers, credentials: 'include' });
  } catch (err) {
    // fetch 本身抛出（断网、DNS 失败、被拦截）说明请求没有拿到任何响应，
    // 包装成 NetworkError 交给上层做离线降级，而不是当成业务失败。
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }

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
  // headers 用于加密文档的 X-Note-Unlock 票据透传
  get: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { headers }),
  post: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(keysToSnake(body)) : undefined,
      headers,
    }),
  patch: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, {
      method: 'PATCH',
      body: body ? JSON.stringify(keysToSnake(body)) : undefined,
      headers,
    }),
  put: <T>(path: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>(path, {
      method: 'PUT',
      body: body ? JSON.stringify(keysToSnake(body)) : undefined,
      headers,
    }),
  delete: <T>(path: string, headers?: Record<string, string>) =>
    request<T>(path, { method: 'DELETE', headers }),
};

export async function fetchWithAuth(path: string, options: RequestInit = {}, retried = false): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  let res: Response;
  try {
    res = await fetch(resolveUrl(path), { ...options, headers, credentials: 'include' });
  } catch (err) {
    throw new NetworkError(err instanceof Error ? err.message : undefined);
  }

  if (res.status === 401 && !retried && !path.includes('/auth/')) {
    const ok = await refreshAccessToken();
    if (ok) return fetchWithAuth(path, options, true);
    setAuthTokens({ accessToken: null });
    window.dispatchEvent(new CustomEvent('auth:unauthorized'));
    throw new Error('Unauthorized');
  }

  return res;
}
