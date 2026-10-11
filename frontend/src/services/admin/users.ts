import { api, buildQuery } from '../client';

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: string;
  role: string;
  createdAt: string;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
}

export interface AdminUserUpdate {
  name?: string;
  status?: string;
  role?: string;
}

export interface ListUsersParams {
  q?: string;
  role?: string;
  status?: string;
  offset?: number;
  limit?: number;
}

export const adminUsersApi = {
  listUsers: (params?: ListUsersParams) =>
    api.get<AdminUserList>(`/admin/users${buildQuery(params as Record<string, unknown>)}`),

  updateUser: (userId: string, data: AdminUserUpdate) =>
    api.patch<AdminUser>(`/admin/users/${userId}`, data),

  /** 软删除：登录与令牌立即失效，笔记数据保留，邮箱释放供重新注册 */
  deleteUser: (userId: string) => api.delete<{ ok: boolean }>(`/admin/users/${userId}`),
};
