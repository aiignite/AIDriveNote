/**
 * 单个同步源的运行时状态 —— 目录句柄、权限、目录内容与一次同步的执行。
 *
 * 两个同步源（notes / kb）各自调用一次本 Hook：句柄、报告、进度完全隔离，
 * 避免出现「绑定一个目录，两种同步抢同一份状态」的混乱。
 */
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import {
  clearHandleFromIndexedDB,
  ensurePermission,
  listDir,
  loadDirNameMirror,
  loadHandleFromIndexedDB,
  pickDirectory,
  queryPermission,
  saveHandleToIndexedDB,
  type DirEntry,
  type SyncDirectoryHandle,
} from '../../services/sync/folderAccess';
import type { SyncSourceKey } from '../../services/sync/kbConfig';
import {
  runSync,
  type SyncMode,
  type SyncOptions,
  type SyncProgress,
  type SyncReport,
} from '../../services/sync/syncEngine';

export type SourceBusy = 'idle' | SyncMode;

export interface SyncSourceRuntime {
  /** 已授权的本机目录句柄 */
  handle: SyncDirectoryHandle | null;
  /** 是否仍持有读写权限 */
  granted: boolean;
  /** 绑定目录名 */
  dirName: string;
  /** 目录直接子条目（用于确认绑的是哪个目录） */
  entries: DirEntry[] | null;
  busy: SourceBusy;
  report: SyncReport | null;
  progress: SyncProgress | null;
  error: string;
  /** 恢复上次授权的句柄与权限状态 */
  load: () => Promise<void>;
  /** 选择并持久化目录句柄 */
  pick: (startIn?: string) => Promise<boolean>;
  /** 断开目录绑定（不动任何文件） */
  disconnect: () => Promise<void>;
  /** 在用户手势中重新申请权限 */
  reauthorize: () => Promise<void>;
  /** 重新读取目录直接子条目 */
  refreshEntries: () => Promise<void>;
  /** 执行一次同步 */
  run: (mode: SyncMode, options: Omit<SyncOptions, 'mode' | 'onProgress'>) => Promise<SyncReport | null>;
  /** 清空上一次的报告 / 错误 */
  reset: () => void;
}

export interface UseSyncSourceOptions {
  /**
   * 授权的目录名必须严格匹配（用于固定目录的知识库源）。
   * 不匹配时拒绝使用该句柄，避免用户把知识库同步到其它目录。
   */
  expectedDirName?: string;
}

/**
 * 创建同步源运行时状态。
 * @param key 同步源标识
 * @param options 固定目录校验等选项
 * @returns 运行时状态与操作函数
 */
export function useSyncSource(
  key: SyncSourceKey,
  options: UseSyncSourceOptions = {},
): SyncSourceRuntime {
  const { expectedDirName } = options;
  const [handle, setHandle] = useState<SyncDirectoryHandle | null>(null);
  const [granted, setGranted] = useState(false);
  const [dirName, setDirName] = useState('');
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [busy, setBusy] = useState<SourceBusy>('idle');
  const [report, setReport] = useState<SyncReport | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState('');

  const refreshEntriesWith = useCallback(async (target: SyncDirectoryHandle) => {
    try {
      setEntries(await listDir(target));
    } catch {
      setEntries([]);
    }
  }, []);

  const refreshEntries = useCallback(async () => {
    if (handle) await refreshEntriesWith(handle);
  }, [handle, refreshEntriesWith]);

  const load = useCallback(async () => {
    // 先读目录名镜像：即使句柄已被浏览器回收，也能告诉用户之前绑的是哪个目录
    const mirrored = loadDirNameMirror(key);
    if (mirrored) setDirName(mirrored);
    const stored = await loadHandleFromIndexedDB(key);
    if (!stored) {
      if (mirrored) {
        setError(
          `之前绑定的文件夹「${mirrored}」的访问授权已被浏览器清除（通常是浏览器回收了本站存储）。请重新选择该文件夹，已同步的文件不会丢失。`,
        );
      }
      return;
    }
    if (expectedDirName && stored.name !== expectedDirName) {
      setHandle(null);
      setGranted(false);
      setDirName(stored.name);
      setEntries(null);
      setError(
        `本地目录固定为 Documents/${expectedDirName}/，当前绑定的是「${stored.name}」。请重新授权正确的文件夹。`,
      );
      return;
    }
    setHandle(stored);
    setDirName(stored.name);
    const ok = await queryPermission(stored);
    setGranted(ok);
    await refreshEntriesWith(stored);
  }, [key, expectedDirName, refreshEntriesWith]);

  const pick = useCallback(
    async (startIn?: string): Promise<boolean> => {
      try {
        const picked = await pickDirectory(key, startIn);
        if (!picked) return false;
        if (expectedDirName && picked.name !== expectedDirName) {
          toast.error(
            `目录名必须是「${expectedDirName}」，请选择 Documents 下的该文件夹`,
          );
          return false;
        }
        await saveHandleToIndexedDB(key, picked);
        setHandle(picked);
        setGranted(true);
        setDirName(picked.name);
        setError('');
        setReport(null);
        await refreshEntriesWith(picked);
        toast.success(`已绑定文件夹：${picked.name}`);
        return true;
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '选择文件夹失败');
        return false;
      }
    },
    [key, expectedDirName, refreshEntriesWith],
  );

  const disconnect = useCallback(async () => {
    await clearHandleFromIndexedDB(key);
    setHandle(null);
    setGranted(false);
    setDirName('');
    setEntries(null);
    setReport(null);
    setError('');
    toast.success('已断开本地文件夹（文件未被改动）');
  }, [key]);

  const reauthorize = useCallback(async () => {
    if (!handle) return;
    const ok = await ensurePermission(handle, { requestInGesture: true });
    setGranted(ok);
    if (!ok) {
      toast.error('未获得文件夹访问权限');
      return;
    }
    toast.success('已重新授权');
    await refreshEntriesWith(handle);
  }, [handle, refreshEntriesWith]);

  const run = useCallback(
    async (
      mode: SyncMode,
      options: Omit<SyncOptions, 'mode' | 'onProgress'>,
    ): Promise<SyncReport | null> => {
      if (!handle) return null;
      setBusy(mode);
      setError('');
      setProgress(null);
      try {
        const result = await runSync(handle, {
          ...options,
          mode,
          onProgress: setProgress,
        });
        setReport(result);
        await refreshEntriesWith(handle);
        if (mode === 'apply') toast.success('同步完成');
        return result;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setBusy('idle');
        setProgress(null);
      }
    },
    [handle, refreshEntriesWith],
  );

  const reset = useCallback(() => {
    setReport(null);
    setError('');
  }, []);

  return {
    handle,
    granted,
    dirName,
    entries,
    busy,
    report,
    progress,
    error,
    load,
    pick,
    disconnect,
    reauthorize,
    refreshEntries,
    run,
    reset,
  };
}
