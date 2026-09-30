/**
 * OfflineSettingsPage – 离线缓存管理。
 *
 * 提供四项能力：
 * 1. 查看本机缓存的笔记条数与存储占用；
 * 2. 手动把全部笔记（含正文）缓存到本机，保证断网时可用；
 * 3. 查看并手动同步待回传队列，展示冲突与失败明细；
 * 4. 清除本机离线缓存。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { CloudOff, Database, RefreshCw, Trash2, Download, AlertTriangle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { cacheAllNotes, clearCache, getCacheStats } from '../../services/offline/noteCache';
import { countOps } from '../../services/offline/offlineDb';
import { runOutbox, type ConflictRecord, type OutboxRunResult } from '../../services/offline/offlineQueue';

/** 把字节数格式化为可读体积 */
function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

const OfflineSettingsPage: React.FC = () => {
  const { theme } = useApp();
  const { user } = useAuth();
  const isDark = theme === 'dark';

  /** 本机缓存的笔记条数 */
  const [count, setCount] = useState(0);
  /** 缓存占用的存储体积 */
  const [usage, setUsage] = useState(0);
  /** 存储配额上限 */
  const [quota, setQuota] = useState(0);
  /** 待同步操作条数 */
  const [pending, setPending] = useState(0);
  /** 是否正在执行批量缓存 */
  const [caching, setCaching] = useState(false);
  /** 批量缓存进度（已完成 / 总数） */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  /** 是否正在回传队列 */
  const [syncing, setSyncing] = useState(false);
  /** 最近一次同步的冲突记录 */
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  /** 最近一次同步的失败记录 */
  const [failures, setFailures] = useState<OutboxRunResult['failed']>([]);
  /** 当前是否在线 */
  const [online, setOnline] = useState(() => navigator.onLine);

  /** 重新读取缓存统计与待同步条数 */
  const refresh = useCallback(async () => {
    try {
      const [stats, ops] = await Promise.all([getCacheStats(), countOps()]);
      setCount(stats.count);
      setUsage(stats.usage);
      setQuota(stats.quota);
      setPending(ops);
    } catch {
      /* 统计失败时保持原值 */
    }
  }, []);

  useEffect(() => {
    void refresh();
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refresh]);

  /** 手动把所有笔记正文缓存到本机 */
  const handleCacheAll = useCallback(async () => {
    if (!user?.id) return;
    setCaching(true);
    setProgress({ done: 0, total: 0 });
    try {
      const done = await cacheAllNotes(user.id, (d, total) => setProgress({ done: d, total }));
      toast.success(`已缓存 ${done} 条笔记到本机`);
      await refresh();
    } catch {
      toast.error('缓存失败，请检查网络后重试');
    } finally {
      setCaching(false);
      setProgress(null);
    }
  }, [user?.id, refresh]);

  /** 手动回传待同步队列 */
  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const result = await runOutbox();
      setConflicts(result.conflicts);
      setFailures(result.failed);
      if (result.paused) {
        toast.error(result.pausedReason ?? '同步已暂停');
      } else if (result.uploaded > 0) {
        toast.success(`已同步 ${result.uploaded} 条修改`);
      } else if (result.conflicts.length === 0 && result.failed.length === 0) {
        toast.success('没有待同步的改动');
      }
      await refresh();
    } catch {
      toast.error('同步失败，请稍后重试');
    } finally {
      setSyncing(false);
    }
  }, [refresh]);

  /** 清除本机全部离线缓存（不影响服务端数据） */
  const handleClear = useCallback(async () => {
    if (!confirm('清除本机离线缓存？服务端数据不受影响，但断网时需重新缓存后才能查看。')) return;
    try {
      await clearCache();
      toast.success('本机缓存已清除');
      await refresh();
    } catch {
      toast.error('清除失败');
    }
  }, [refresh]);

  const cardClass = `rounded-xl border p-4 ${
    isDark ? 'border-gray-800 bg-gray-900' : 'border-gray-200 bg-white'
  }`;
  const titleClass = `text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`;
  const subClass = `text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`;
  const rowClass = `flex items-center justify-between py-1.5 ${subClass}`;

  const quotaRatio = quota > 0 ? Math.min(usage / quota, 1) : 0;

  return (
    <div className={`h-full overflow-y-auto ${isDark ? 'bg-gray-950' : 'bg-slate-50'}`}>
      <div className="mx-auto max-w-3xl space-y-4 p-6">
        <div>
          <h1 className={`flex items-center gap-2 text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <CloudOff size={18} className="text-orange-500" />
            离线缓存
          </h1>
          <p className={`mt-1 ${subClass}`}>
            把笔记缓存到本机后，即使断网也能打开、查看和编辑；断网期间的改动会在恢复联网后自动同步。
          </p>
        </div>

        {/* 状态概览 */}
        <div className={cardClass}>
          <div className="flex items-center gap-2 mb-2">
            <Database size={15} className="text-orange-500" />
            <h2 className={titleClass}>本机缓存</h2>
            <span
              className={`ml-auto rounded-full px-2 py-0.5 text-[10px] font-medium ${
                online
                  ? isDark
                    ? 'bg-green-900/40 text-green-300'
                    : 'bg-green-50 text-green-700'
                  : isDark
                    ? 'bg-amber-900/40 text-amber-300'
                    : 'bg-amber-50 text-amber-700'
              }`}
            >
              {online ? '在线' : '已离线'}
            </span>
          </div>
          <div className={rowClass}>
            <span>已缓存笔记</span>
            <span className={`font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>{count} 条</span>
          </div>
          <div className={rowClass}>
            <span>存储占用</span>
            <span className={`font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
              {formatBytes(usage)}
              {quota > 0 && ` / ${formatBytes(quota)}`}
            </span>
          </div>
          {quota > 0 && (
            <div className={`mt-1 h-1.5 w-full overflow-hidden rounded-full ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
              <div className="h-full rounded-full bg-orange-500" style={{ width: `${quotaRatio * 100}%` }} />
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void handleCacheAll()}
              disabled={caching || !online}
              className="inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
            >
              <Download size={13} />
              {caching
                ? progress && progress.total > 0
                  ? `缓存中 ${progress.done}/${progress.total}`
                  : '缓存中...'
                : '缓存全部笔记'}
            </button>
            <button
              type="button"
              onClick={() => void handleClear()}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                isDark
                  ? 'border-gray-700 text-gray-300 hover:bg-gray-800'
                  : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <Trash2 size={13} />
              清除本机缓存
            </button>
          </div>
        </div>

        {/* 待同步队列 */}
        <div className={cardClass}>
          <div className="flex items-center gap-2 mb-2">
            <RefreshCw size={15} className="text-orange-500" />
            <h2 className={titleClass}>待同步改动</h2>
            <span className={`ml-auto text-xs font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
              {pending} 条
            </span>
          </div>
          <p className={subClass}>
            断网期间的增删改会先存在本机，恢复联网后自动回传。所有同步都不会覆盖服务端上更新的内容，
            遇到双端冲突时会自动保留一份本地副本。
          </p>
          <button
            type="button"
            onClick={() => void handleSync()}
            disabled={syncing || !online || pending === 0}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-700 disabled:opacity-50"
          >
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? '同步中...' : '立即同步'}
          </button>

          {conflicts.length > 0 && (
            <div className={`mt-3 rounded-lg border p-2.5 ${isDark ? 'border-amber-800 bg-amber-950/40' : 'border-amber-200 bg-amber-50'}`}>
              <p className={`flex items-center gap-1.5 text-xs font-medium ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
                <AlertTriangle size={13} />
                {conflicts.length} 条冲突
              </p>
              <ul className={`mt-1.5 space-y-1 text-[11px] ${isDark ? 'text-amber-200/90' : 'text-amber-700'}`}>
                {conflicts.map((c) => (
                  <li key={c.noteId}>
                    《{c.title}》：{c.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {failures.length > 0 && (
            <div className={`mt-3 rounded-lg border p-2.5 ${isDark ? 'border-red-900 bg-red-950/40' : 'border-red-200 bg-red-50'}`}>
              <p className={`text-xs font-medium ${isDark ? 'text-red-300' : 'text-red-700'}`}>
                {failures.length} 条未能同步
              </p>
              <ul className={`mt-1.5 space-y-1 text-[11px] ${isDark ? 'text-red-200/90' : 'text-red-600'}`}>
                {failures.map((f, i) => (
                  <li key={`${f.title}-${i}`}>
                    《{f.title}》：{f.message}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default OfflineSettingsPage;