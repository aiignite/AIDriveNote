import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  CheckCircle2,
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
  isSupported,
  loadHandleFromIndexedDB,
  pickDirectory,
  queryPermission,
  saveHandleToIndexedDB,
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
  const [busy, setBusy] = useState<'idle' | 'compare' | 'apply'>('idle');
  const [report, setReport] = useState<SyncReport | null>(null);
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [error, setError] = useState('');
  const [showOrphans, setShowOrphans] = useState(false);
  const autoComparedRef = useRef(false);

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
        if (mode === 'apply') toast.success('同步完成');
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy('idle');
        setProgress(null);
      }
    },
    [user?.id],
  );

  // 打开页面时恢复上次授权的目录，并在有权限的前提下自动对比一次
  useEffect(() => {
    if (!supported || autoComparedRef.current) return;
    autoComparedRef.current = true;
    void (async () => {
      const stored = await loadHandleFromIndexedDB();
      if (!stored) return;
      setHandle(stored);
      const ok = await queryPermission(stored);
      setGranted(ok);
      if (ok) await run('compare', stored);
    })();
  }, [supported, run]);

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
      setReport(null);
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
    await run('compare', handle);
  };

  /**
   * 断开本地文件夹绑定（只清除授权记录，不动任何文件）。
   */
  const handleDisconnect = async () => {
    await clearHandleFromIndexedDB();
    setHandle(null);
    setGranted(false);
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
                className={`mt-4 flex items-center justify-between gap-3 rounded-xl border p-3 ${
                  isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'
                }`}
              >
                <div className="min-w-0">
                  <p className={`text-xs ${muted}`}>已绑定文件夹</p>
                  <p className={`text-sm font-medium truncate ${isDark ? 'text-gray-200' : 'text-gray-900'}`}>
                    {handle.name}
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