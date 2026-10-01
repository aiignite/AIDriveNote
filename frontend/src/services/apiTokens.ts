import { api } from './client';

// ── 类型定义 ──────────────────────────────────────────────

/** 访问令牌（列表项，不含明文） */
export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt?: string;
  expiresAt?: string;
  isRevoked: boolean;
  createdAt?: string;
}

/** 新建令牌的响应：额外携带仅返回一次的明文令牌 */
export interface ApiTokenCreated extends ApiToken {
  token: string;
}

// ── API ──────────────────────────────────────────────

export const apiTokenApi = {
  /** 列出当前用户的全部访问令牌 */
  list: () => api.get<ApiToken[]>('/api-tokens'),

  /** 签发新令牌，响应中携带明文（仅此一次） */
  create: (data: { name: string; expiresInDays?: number }) =>
    api.post<ApiTokenCreated>('/api-tokens', data),

  /** 撤销指定令牌 */
  revoke: (id: string) => api.delete(`/api-tokens/${id}`),
};