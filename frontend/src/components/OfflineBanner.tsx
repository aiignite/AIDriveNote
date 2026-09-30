/**
 * OfflineBanner – 全局离线状态提示条。
 *
 * 职责：
 * - 监听浏览器 online / offline 事件，实时反映网络状态；
 * - 断网时提示「已离线」，并说明改动会在联网后自动同步；
 * - 恢复联网时自动回传本地待同步队列（runOutbox）；
 * - 当 Service Worker 新版本就绪时提示用户刷新。
 *
 * 设计约束：
 * - 本组件只读取本地队列与网络状态，不发起任何业务写请求，避免误触发；
 * - 所有回传都走 offlineQueue 的统一入口，天然继承批量删除保护与冲突不覆盖策略。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CloudOff, RefreshCw, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../contexts/AppContext';
import { countOps } from '../services/offline/offlineDb';
import { runOutbox } from '../services/offline/offlineQueue';
import { applyUpdate, onUpdateAvailable } from '../services/offline/swRegister';

const OfflineBanner: React.FC = () => {
  const { theme } = useApp();
  const isDark = theme === 'dark';

  /** 当前是否处于离线状态 */
  const [offline, setOffline] = useState(() => !navigator.onLine);
  /** 待同步操作条数 */
  const [pending, setPending] = useState(0);
  /** 是否正在回传队列 */
  const [syncing, setSyncing] = useState(false);
  /** 用户是否主动关闭了「在线待同步」提示 */
  const [dismissed, setDismissed] = useState(false);
  /** Service Worker 新版本是否已就绪 */
  const [updateReady, setUpdateReady] = useState(false);
  /** 同步中标志（ref 形式，供事件回调读取最新值而不触发重订阅） */
  const syncingRef = useRef(false);

  /** 刷新待同步条数 */
  const refreshPending = useCallback(async () => {
    try {
      setPending(await countOps());
    } catch {
      /* 统计失败不影响提示条本身 */
    }
  }, []);

  /** 回传本地队列并汇报结果 */
  const sync = useCallback(async () => {
    if (syncingRef.current) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const result = await runOutbox();
      if (result.paused) {
        toast.error(result.pausedReason ?? '同步已暂停，请在设置中手动确认');
      } else if (result.uploaded > 0) {
        toast.success(`已同步 ${result.uploaded} 条离线修改`);
      }
      if (result.conflicts.length > 0) {
        toast.error(`${result.conflicts.length} 条笔记存在冲突，本地版本已另存为副本`);
      }
      if (result.failed.length > 0) {
        toast.error(`${result.failed.length} 条修改未能同步，将稍后重试`);
      }
    } catch {
      /* 回传异常静默处理，队列保留待下次 */
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      void refreshPending();
    }
  }, [refreshPending]);

  // 网络状态监听：恢复联网时自动回传
  useEffect(() => {
    const handleOnline = () => {
      setOffline(false);
      setDismissed(false);
      void sync();
    };
    const handleOffline = () => {
      setOffline(true);
      void refreshPending();
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // 首次挂载：统计历史遗留的待同步操作，在线时立即尝试回传
    void refreshPending().then(() => {
      if (navigator.onLine) void sync();
    });

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [sync, refreshPending]);

  // Service Worker 新版本通知
  useEffect(() => {
    onUpdateAvailable(() => setUpdateReady(true));
  }, []);

  const showOffline = offline;
  const showPending = !offline && pending > 0 && !dismissed;
  const showUpdate = updateReady;

  if (!showOffline && !showPending && !showUpdate) return null;

  const barClass = showOffline
    ? isDark
      ? 'bg-amber-950/70 text-amber-200 border-amber-800'
      : 'bg-amber-50 text-amber-800 border-amber-200'
    : isDark
      ? 'bg-sky-950/60 text-sky-200 border-sky-800'
      : 'bg-sky-50 text-sky-700 border-sky-200';

  return (
    <div className={`flex items-center gap-2 px-4 py-1.5 border-b text-xs ${barClass}`}>
      {showOffline && (
        <>
          <CloudOff size={14} className="shrink-0" />
          <span className="font-medium">已离线</span>
          <span className="opacity-80">
            断网期间可正常查看与编辑，{pending > 0 ? `${pending} 条改动` : '改动'}会在联网后自动同步
          </span>
        </>
      )}

      {showPending && (
        <>
          <RefreshCw size={14} className="shrink-0" />
          <span className="font-medium">有 {pending} 条改动待同步</span>
          <button
            type="button"
            onClick={() => void sync()}
            disabled={syncing}
            className="ml-1 rounded px-2 py-0.5 font-medium underline underline-offset-2 disabled:opacity-50"
          >
            {syncing ? '同步中...' : '立即同步'}
          </button>
        </>
      )}

      {showUpdate && (
        <>
          <span className="font-medium">新版本已就绪</span>
          <button
            type="button"
            onClick={() => applyUpdate()}
            className="ml-1 rounded px-2 py-0.5 font-medium underline underline-offset-2"
          >
            刷新启用
          </button>
        </>
      )}

      <div className="flex-1" />

      {showPending && (
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="shrink-0 opacity-60 hover:opacity-100"
          title="关闭"
        >
          <X size={13} />
        </button>
      )}
    </div>
  );
};

export default OfflineBanner;