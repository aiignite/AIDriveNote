import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Folder,
  FolderSync,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  ShieldAlert,
  Unplug,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  clearHandleFromIndexedDB,
  ensurePermission,
  isPersistent,
  isSupported,
  listDir,
  loadDirNameMirror,
  loadHandleFromIndexedDB,
  pickDirectory,
  queryPermission,
  saveHandleToIndexedDB,
  type DirEntry,
  type SyncDirectoryHandle,
} from '../../services/sync/folderAccess';
import {
  runSync,
  type SyncProgress,
  type SyncReport,
} from '../../services/sync/syncEngine';

/**
 * 本地同步设置页。
 *
 * 提供「选择本地文件夹 → 对比 → 同步」的完整流程，
 * 并明确展示同步范围与数据安全说明（删除进回收站、冲突保留副本）。
 */
const SyncSettingsPage: React.FC = () => {
  const { theme } = useApp();
  const { user } = useAuth();
  const isDark = theme === 'dark';
  const supported = useMemo(() => isSupported(), []);

  const [handle, setHandle] = useState<SyncDirectoryHandle | null>(null);
  const [granted, setGranted] = useState(false);
  const [dirName, setDirName] = useState('');
  const [entries, setEntries] = useState<DirEntry[] | null>(null);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<'idle' | 'compare' | 'apply'>('idle');
  const [report, setReport] = useState<SyncReport | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState('');
  const [showOrphans, setShowOrphans] = useState(false);
  const autoComparedRef = useRef(false);

  /**
   * 读取已绑定目录的直接子条目，用于在页面上展示文件夹与文件名称。
   * 只列一层：既能让用户确认「绑的是哪个目录、里面有什么」，
   * 又不会把上千个文件全塞进页面拖慢渲染。
   * @param target 目录句柄
   */
  const refreshEntries = useCallback(async (target: SyncDirectoryHandle) => {
    try {
      setEntries(await listDir(target));
    } catch {
      setEntries([]);
    }
  }, []);

  /**
   * 执行一次同步（compare 只出报告，apply 真正写盘）。
   * @param mode 运行模式
   * @param target 目标目录句柄
   */
  const run = useCallback(
    async (mode: 'compare' | 'apply', target: SyncDirectoryHandle) => {
      if (!user?.id) {
        setError('未获取到当前用户信息，请重新登录后再试');
        return;
      }
      setBusy(mode);
      setError('');
      setProgress(null);
      try {
        const result = await runSync(target, {
          mode,
          userId: user.id,
          onProgress: setProgress,
        });
        setReport(result);
        await refreshEntries(target);
        if (mode === 'apply') toast.success('同步完成');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy('idle');
        setProgress(null);
      }
    },
    [user?.id, refreshEntries],
  );

  // 打开页面时恢复上次授权的目录，并在有权限的前提下自动对比一次
  useEffect(() => {
    if (!supported) return;
    void isPersistent().then(setPersistent);
    if (autoComparedRef.current) return;
    autoComparedRef.current = true;
    void (async () => {
      // 先读目录名镜像：即使句柄已被浏览器回收，也能告诉用户之前绑的是哪个目录
      const mirrored = loadDirNameMirror();
      if (mirrored) setDirName(mirrored);
      const stored = await loadHandleFromIndexedDB();
      if (!stored) {
        // 句柄消失但镜像还在 —— 说明 IndexedDB 被回收了，明确提示用户重新绑定
        if (mirrored) {
          setError(
            `之前绑定的文件夹「${mirrored}」的访问授权已被浏览器清除（通常是浏览器回收了本站存储）。请重新选择该文件夹，已同步的文件不会丢失。`
          );
        }
        return;
      }
      setHandle(stored);
      setDirName(stored.name);
      const ok = await queryPermission(stored);
      setGranted(ok);
      await refreshEntries(stored);
      if (ok) await run('compare', stored);
    })();
  }, [supported, run, refreshEntries]);

  /**
   * 选择本地文件夹并持久化句柄。
   */
  const handlePick = async () => {
    try {
      const picked = await pickDirectory();
      if (!picked) return;
      await saveHandleToIndexedDB(picked);
      setHandle(picked);
      setGranted(true);
      setDirName(picked.name);
      setError('');
      setReport(null);
      await refreshEntries(picked);
      setPersistent(await isPersistent());
      toast.success(`已绑定文件夹：${picked.name}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '选择文件夹失败');
    }
  };

  /**
   * 在用户手势中重新申请目录权限（浏览器强制要求）。
   */
  const handleReauthorize = async () => {
    if (!handle) return;
    const ok = await ensurePermission(handle, { requestInGesture: true });
    setGranted(ok);
    if (!ok) {
      toast.error('未获得文件夹访问权限');
      return;
    }
    toast.success('已重新授权');
    await refreshEntries(handle);
    await run('compare', handle);
  };

  /**
   * 断开本地文件夹绑定（只清除授权记录，不动任何文件）。
   */
  const handleDisconnect = async () => {
    await clearHandleFromIndexedDB();
    setHandle(null);
    setGranted(false);
    setDirName('');
    setEntries(null);
    setReport(null);
    setError('');
    toast.success('已断开本地文件夹（文件未被改动）');
  };

  const card = `bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm`;
  const muted = isDark ? 'text-gray-400' : 'text-gray-500';

  if (!supported) {
    return (
      <div className="h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6">
        <div className="max-w-4xl mx-auto">
          <div className={card}>
            <div className="p-5">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
                  <FolderSync className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">本地同步</h2>
                  <p className={`text-sm ${muted}`}>把笔记以原生文件镜像到本机文件夹</p>
                </div>
              </div>
              <div
                className={`mt-4 flex items-start gap-2 rounded-xl border p-3 text-sm ${
                  isDark
                    ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
                <span>
                  当前浏览器不支持本机文件夹访问（File System Access API）。
                  请使用 Chrome / Edge 桌面版，并确保通过 HTTPS 或 localhost 访问。
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 overflow-auto bg-slate-50 dark:bg-gray-950 p-4 lg:p-6">
      <div className="max-w-4xl mx-auto space-y-4">
        {/* 头部卡片 */}
        <div className={card}>
          <div className="p-5">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
                  <FolderSync className="w-5 h-5 text-white" />
                </div>
                <div>
                  <h2 className="text-xl font-bold text-gray-900 dark:text-white">本地同步</h2>
                  <p className={`text-sm ${muted}`}>
                    笔记以 .md / .json / .drawio 原生文件镜像到本机文件夹，双向增量同步
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void handlePick()}
                  className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
                >
                  <HardDriveDownload size={15} />
                  {handle ? '更换文件夹' : '选择本地文件夹'}
                </button>
                {handle && (
                  <button
                    type="button"
                    onClick={() => void handleDisconnect()}
                    className={`p-2 rounded-lg transition-colors ${
                      isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                    }`}
                    title="断开绑定"
                  >
                    <Unplug size={16} />
                  </button>
                )}
              </div>
            </div>

            {/* 已绑定目录 */}
            {handle && (
              <div
                className={`mt-4 rounded-xl border p-3 ${
                  isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0 flex items-center gap-2">
                    <Folder size={14} className="text-amber-400 shrink-0" />
                    <p className={`text-xs ${muted} shrink-0`}>已绑定文件夹</p>
                    <p
                      className={`text-sm font-medium truncate ${
                        isDark ? 'text-gray-200' : 'text-gray-900'
                      }`}
                      title={dirName}
                    >
                      {dirName}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {granted ? (
                      <span
                        className={`flex items-center gap-1 text-xs ${
                          isDark ? 'text-emerald-400' : 'text-emerald-600'
                        }`}
                      >
                        <CheckCircle2 size={14} /> 已授权
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleReauthorize()}
                        className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                          isDark
                            ? 'border-amber-800 text-amber-300 hover:bg-amber-950/50'
                            : 'border-amber-300 text-amber-700 hover:bg-amber-50'
                        }`}
                      >
                        <ShieldAlert size={13} /> 重新授权
                      </button>
                    )}
                  </div>
                </div>

                {/* 目录内容：让用户一眼确认绑的是哪个目录、里面已经有哪些文件和子文件夹 */}
                {entries && entries.length > 0 && (
                  <div className="mt-2.5 border-t border-dashed border-gray-300 dark:border-gray-700 pt-2.5">
                    <p className={`text-xs ${muted} mb-1.5`}>
                      目录内容（{entries.length} 项）
                    </p>
                    <ul
                      className={`grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 text-xs ${
                        isDark ? 'text-gray-400' : 'text-gray-500'
                      }`}
                    >
                      {entries.map((entry) => (
                        <li key={`${entry.kind}-${entry.name}`} className="flex items-center gap-1.5 min-w-0">
                          {entry.kind === 'directory' ? (
                            <Folder size={12} className="text-amber-400 shrink-0" />
                          ) : (
                            <FileText size={12} className="shrink-0" />
                          )}
                          <span className="truncate" title={entry.name}>
                            {entry.name}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {entries && entries.length === 0 && (
                  <p className={`mt-2 text-xs ${muted}`}>
                    该文件夹目前为空，执行一次同步后笔记会以原生文件写入这里。
                  </p>
                )}
              </div>
            )}

            {/* 操作按钮 */}
            <div className="mt-4 flex items-center gap-2">
              <button
                type="button"
                disabled={!handle || !granted || busy !== 'idle'}
                onClick={() => handle && void run('compare', handle)}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                  isDark
                    ? 'border-gray-700 text-gray-200 hover:bg-gray-700'
                    : 'border-gray-200 text-gray-700 hover:bg-gray-100'
                }`}
              >
                {busy === 'compare' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <RefreshCw size={15} />
                )}
                对比（只读）
              </button>
              <button
                type="button"
                disabled={!handle || !granted || busy !== 'idle'}
                onClick={() => handle && void run('apply', handle)}
                className="flex items-center gap-1.5 rounded-lg bg-orange-600 px-3 py-2 text-sm font-medium text-white hover:bg-orange-700 disabled:opacity-50 transition-colors"
              >
                {busy === 'apply' ? (
                  <Loader2 size={15} className="animate-spin" />
                ) : (
                  <FolderSync size={15} />
                )}
                开始同步
              </button>
              {progress && (
                <span className={`text-xs ${muted}`}>
                  {progress.phase}
                  {progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}
                </span>
              )}
            </div>

            {error && (
              <p className={`mt-3 text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>
            )}

            {/* 未获得持久化存储时给出预警：浏览器可能回收 IndexedDB，导致目录授权丢失 */}
            {handle && persistent === false && (
              <div
                className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs ${
                  isDark
                    ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  浏览器未授予本站「持久化存储」。磁盘空间紧张或长时间不访问时，本地文件夹的授权记录
                  <code className="mx-1">IndexedDB</code>
                  可能被系统清除，届时需要重新绑定一次（已同步的文件不受影响）。
                </span>
              </div>
            )}
          </div>
        </div>

        {/* 结果面板 */}
        {report && (
          <div className={card}>
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className={`text-sm font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                  {report.mode === 'compare' ? '对比结果（未写入任何内容）' : '同步结果'}
                </h3>
                <span className={`text-xs ${muted}`}>耗时 {report.durationMs} ms</span>
              </div>

              {report.hashDegraded && (
                <div
                  className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
                    isDark
                      ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                      : 'border-amber-200 bg-amber-50 text-amber-700'
                  }`}
                >
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    当前非安全上下文，无法计算内容哈希，已降级为「文件大小 + 修改时间」判断变更，精度下降。
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <Stat label="下载到本地" value={report.downloaded} isDark={isDark} />
                <Stat label="上传到服务端" value={report.uploaded} isDark={isDark} />
                <Stat label="冲突副本" value={report.conflicts.length} isDark={isDark} />
                <Stat label="本地删除同步" value={report.localDeleted.length} isDark={isDark} />
                <Stat label="远端删除移入回收站" value={report.remoteDeleted.length} isDark={isDark} />
                <Stat label="新建文件夹" value={report.uploadedFolders.length} isDark={isDark} />
              </div>

              {report.conflicts.length > 0 && (
                <PathList
                  title="冲突副本（本地修改已保留）"
                  items={report.conflicts}
                  isDark={isDark}
                />
              )}
              {report.remoteDeleted.length > 0 && (
                <PathList
                  title="已移入 .aidrivenote/trash/ 的文件"
                  items={report.remoteDeleted}
                  isDark={isDark}
                />
              )}
              {report.skippedLocalChanges.length > 0 && (
                <PathList
                  title="未写入的本地差异（内容与远端不一致，或目标路径已被占用）"
                  items={report.skippedLocalChanges}
                  isDark={isDark}
                />
              )}
              {report.errors.length > 0 && (
                <div>
                  <p className={`text-xs font-medium mb-1.5 ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                    失败 {report.errors.length} 条
                  </p>
                  <ul className={`space-y-1 text-xs ${muted}`}>
                    {report.errors.map((e, i) => (
                      <li key={i} className="break-all">
                        {e.path}：{e.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {report.skippedOrphans.length > 0 && (
                <div>
                  <button
                    type="button"
                    onClick={() => setShowOrphans((v) => !v)}
                    className={`text-xs font-medium ${isDark ? 'text-gray-300' : 'text-gray-700'}`}
                  >
                    跳过 {report.skippedOrphans.length} 个非本应用文件（未导入、未改动）{showOrphans ? ' ▾' : ' ▸'}
                  </button>
                  {showOrphans && (
                    <ul className={`mt-1.5 space-y-1 text-xs ${muted}`}>
                      {report.skippedOrphans.map((p) => (
                        <li key={p} className="break-all">
                          {p}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* 说明 */}
        <div className={card}>
          <div className="p-5">
            <h3 className={`text-sm font-bold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
              同步说明
            </h3>
            <ul className={`space-y-1.5 text-xs ${muted}`}>
              <li>· Markdown 笔记带 YAML frontmatter（含 id/title/tags/folder），JSON 与 drawio 保持原生格式。</li>
              <li>· 笔记内嵌图片以 base64 内联在文件中，不需要也不支持单独抽离为图片文件。</li>
              <li>· AI 聊天附件不在同步范围内（它们挂在会话上，不属于笔记）。</li>
              <li>· 服务端删除笔记时，本地文件会移入 <code>.aidrivenote/trash/</code>，不会真正删除。</li>
              <li>· 本地删除文件时，服务端笔记走软删除，可在回收站中恢复。</li>
              <li>· 两端都改过同一条笔记时，本地修改会另存为 <code>标题.conflict-时间戳.扩展名</code> 副本。</li>
              <li>· 同步状态记录在 <code>.aidrivenote/sync.json</code>；删除它只影响差异判断，不会丢数据。</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
};

/** 统计数字卡片 */
const Stat: React.FC<{ label: string; value: number; isDark: boolean }> = ({
  label,
  value,
  isDark,
}) => (
  <div
    className={`rounded-xl border p-3 ${
      isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'
    }`}
  >
    <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</p>
    <p className={`text-lg font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>{value}</p>
  </div>
);

/** 路径列表 */
const PathList: React.FC<{ title: string; items: string[]; isDark: boolean }> = ({
  title,
  items,
  isDark,
}) => (
  <div>
    <p className={`text-xs font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
      {title}
    </p>
    <ul className={`space-y-1 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
      {items.map((item) => (
        <li key={item} className="break-all">
          {item}
        </li>
      ))}
    </ul>
  </div>
);

export default SyncSettingsPage;