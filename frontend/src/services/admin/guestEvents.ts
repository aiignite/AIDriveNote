import { api, buildQuery } from '../client';

/** 匿名会话事件类型（固定枚举，与后端 GuestEventType 一致） */
export type GuestEventType = 'login' | 'logout' | 'session_end' | 'purge' | 'blocked';

export interface GuestEvent {
  id: string;
  guestId: string;
  eventType: GuestEventType;
  ipAddress: string | null;
  userAgent: string | null;
  eventAt: string;
  sessionDurationSeconds: number | null;
  noteCountAtEnd: number | null;
  detail: string | null;
}

export interface GuestEventList {
  items: GuestEvent[];
  total: number;
}

export interface GuestEventStats {
  totalEvents: number;
  distinctGuests: number;
  byEventType: Record<string, number>;
  logins: number;
  logouts: number;
  purges: number;
}

export interface ListGuestEventsParams {
  guestId?: string;
  eventType?: GuestEventType | '';
  offset?: number;
  limit?: number;
}

export const adminGuestEventsApi = {
  listEvents: (params?: ListGuestEventsParams) =>
    api.get<GuestEventList>(`/admin/guest-events${buildQuery(params as Record<string, unknown>)}`),

  stats: () => api.get<GuestEventStats>('/admin/guest-events/stats'),

  /** 立即执行一次超时匿名账号清除（与后台定时任务同一逻辑，幂等） */
  purgeNow: () => api.post<{ ok: boolean; purged: number }>('/admin/guests/purge'),
};
