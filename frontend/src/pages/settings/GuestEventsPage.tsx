import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, RefreshCw, Search, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../../contexts/AppContext';
import {
  adminGuestEventsApi,
  type GuestEvent,
  type GuestEventStats,
  type GuestEventType,
} from '../../services/admin/guestEvents';

/** 事件类型 → 中文标签与配色 */
const EVENT_META: Record<GuestEventType, { label: string; cls: string }> = {
  login: { label: '匿名登录', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300' },
  logout: { label: '主动退出', cls: 'bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300' },
  session_end: { label: '会话结束', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300' },
  purge: { label: '数据清除', cls: 'bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300' },
  blocked: { label: '功能受限', cls: 'bg-gray-200 text-gray-700 dark:bg-gray-700 dark:text-gray-300' },
};

const EVENT_TYPES = Object.keys(EVENT_META) as GuestEventType[];

const formatTime = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
};

const formatDuration = (seconds: number | null) => {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟`;
  return `${(seconds / 3600).toFixed(1)} 小时`;
};

const GuestEventsPage: React.FC = () => {
  const { theme } = useApp();
  const isDark = theme === 'dark';
  const [events, setEvents] = useState<GuestEvent[]>([]);
  const [stats, setStats] = useState<GuestEventStats | null>(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [purging, setPurging] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'all' | GuestEventType>('all');
  const [guestSearch, setGuestSearch] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, stat] = await Promise.all([
        adminGuestEventsApi.listEvents({
          eventType: typeFilter === 'all' ? undefined : typeFilter,
          guestId: guestSearch.trim() || undefined,
          limit: 100,
        }),
        adminGuestEventsApi.stats(),
      ]);
      setEvents(list.items);
      setTotal(list.total);
      setStats(stat);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载匿名事件失败');
    } finally {
      setLoading(false);
    }
  }, [typeFilter, guestSearch]);

  useEffect(() => {
    void load();
  }, [load]);

  const handlePurge = useCallback(async () => {
    setPurging(true);
    try {
      const res = await adminGuestEventsApi.purgeNow();
      toast.success(res.purged > 0 ? `已清除 ${res.purged} 个超时匿名账号` : '暂无超时的匿名账号');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清除失败');
    } finally {
      setPurging(false);
    }
  }, [load]);

  const summary = useMemo(
    () => (stats
      ? `${stats.distinctGuests} 位匿名访客 · ${stats.logins} 次登录 · ${stats.purges} 次清除`
      : `${events.length} / ${total} 条事件`),
    [stats, events.length, total],
  );

  const inputCls = `w-full rounded-lg border px-3 py-2 text-sm ${
    isDark
      ? 'border-gray-700 bg-gray-800 text-gray-100 placeholder-gray-500'
      : 'border-gray-200 bg-white text-gray-900 placeholder-gray-400'
  }`;

  return (
    <div className="h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 shadow-lg shadow-indigo-500/20">
                  <Activity className="h-5 w-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">匿名事件</h2>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    匿名用户的登录信息与会话生命周期（仅元数据，不含笔记内容）
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void load()}
                  className="rounded-lg p-2 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-700 dark:hover:text-gray-300"
                  title="刷新"
                >
                  <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => void handlePurge()}
                  disabled={purging}
                  className="flex items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-rose-700 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {purging ? '清除中…' : '立即清除超时账号'}
                </button>
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <div className="relative min-w-56 flex-1">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                <input
                  value={guestSearch}
                  onChange={e => setGuestSearch(e.target.value)}
                  placeholder="按匿名账号 ID 搜索"
                  className={`${inputCls} pl-9`}
                />
              </div>
              <select
                value={typeFilter}
                onChange={e => setTypeFilter(e.target.value as 'all' | GuestEventType)}
                className={`${inputCls} w-auto`}
              >
                <option value="all">全部类型</option>
                {EVENT_TYPES.map(t => (
                  <option key={t} value={t}>{EVENT_META[t].label}</option>
                ))}
              </select>
              <span className="text-sm text-gray-500 dark:text-gray-400">{summary}</span>
            </div>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-gray-100 bg-white shadow-sm dark:border-gray-700 dark:bg-gray-800">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-500 dark:bg-gray-700/50 dark:text-gray-400">
                <tr>
                  <th className="px-4 py-3 font-medium">时间</th>
                  <th className="px-4 py-3 font-medium">事件</th>
                  <th className="px-4 py-3 font-medium">匿名账号</th>
                  <th className="px-4 py-3 font-medium">IP</th>
                  <th className="px-4 py-3 font-medium">客户端</th>
                  <th className="px-4 py-3 font-medium">存活时长</th>
                  <th className="px-4 py-3 font-medium">笔记数</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {loading && events.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                      加载中…
                    </td>
                  </tr>
                )}
                {!loading && events.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-10 text-center text-gray-400">
                      暂无匿名事件
                    </td>
                  </tr>
                )}
                {events.map(ev => {
                  const meta = EVENT_META[ev.eventType] ?? EVENT_META.blocked;
                  return (
                    <tr key={ev.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/40">
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatTime(ev.eventAt)}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${meta.cls}`}>
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-500 dark:text-gray-400">
                        {ev.guestId.slice(0, 8)}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs text-gray-600 dark:text-gray-300">
                        {ev.ipAddress || '—'}
                      </td>
                      <td className="max-w-56 truncate px-4 py-3 text-xs text-gray-500 dark:text-gray-400"
                        title={ev.userAgent || undefined}>
                        {ev.userAgent || '—'}
                      </td>
                      <td className="whitespace-nowrap px-4 py-3 text-gray-600 dark:text-gray-300">
                        {formatDuration(ev.sessionDurationSeconds)}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {ev.noteCountAtEnd ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
};

export default GuestEventsPage;
