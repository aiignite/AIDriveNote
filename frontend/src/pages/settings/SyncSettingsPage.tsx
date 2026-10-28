import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  Database,
  FileText,
  Folder,
  FolderSync,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { noteFolderApi, type NoteFolder } from '../../services/note';
import {
  clearHandleFromIndexedDB,
  ensurePermission,
  isPersistent,
  isSupported,
  listDir,
  listAllFiles,
  loadDirNameMirror,
  loadHandleFromIndexedDB,
  pickDirectory,
  queryPermission,
  readFile,
  saveHandleToIndexedDB,
  type DirEntry,
  type SyncDirectoryHandle,
} from '../../services/sync/folderAccess';
import { kbApi, type KbFileInfo } from '../../services/kb';
import {
  KB_PRESET_IGNORE,
  KB_PRESET_PROTECT,
  loadKbConfig,
  saveKbConfig,
  type KbConfig,
} from '../../services/sync/kbConfig';
import {
  runSync,
  type SyncDirection,
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
  const { theme, bumpNotesRefresh } = useApp();
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

  // ── 知识库管理模式 ──
  const [kb, setKb] = useState<KbConfig>(() => loadKbConfig());
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [ignoreDraft, setIgnoreDraft] = useState(() => loadKbConfig().ignore.join('\n'));
  const [protectDraft, setProtectDraft] = useState(() => loadKbConfig().protect.join('\n'));
  const [kbAssets, setKbAssets] = useState<KbFileInfo[]>([]);
  const [kbAssetBusy, setKbAssetBusy] = useState(false);
  const [kbRootId, setKbRootId] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const roots = await kbApi.listRoots();
        if (roots[0]) {
          setKbRootId(roots[0].id);
          setKbAssets(await kbApi.listFiles(undefined, 30));
        }
      } catch {
        /* 未登录/网络异常时静默，页面其余功能不受影响 */
      }
    })();
  }, []);

  /** 当前同步方向：启用知识库模式且已指定根文件夹时为 kb */
  const direction: SyncDirection = kb.enabled && kb.rootFolderId ? 'kb' : 'two-way';

  /**
   * 把文件夹 ID 还原为「父/子」可读路径（用于选择器展示）。
   * @param folderId 文件夹 ID
   * @param list 文件夹列表
   * @returns 层级路径；找不到时返回空字符串
   */
  const folderLabel = useCallback((folderId: string, list: NoteFolder[]): string => {
    const byId = new Map(list.map((f) => [f.id, f]));
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur = byId.get(folderId);
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join('/');
  }, []);

  /**
   * 读取笔记文件夹列表，供「知识库根文件夹」选择器使用。
   */
  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await noteFolderApi.list());
    } catch {
      setFolders([]);
    }
  }, []);

  /**
   * 保存知识库配置并同步草稿状态。
   * @param next 新配置
   */
  const persistKb = useCallback((next: KbConfig) => {
    setKb(next);
    saveKbConfig(next);
    setIgnoreDraft(next.ignore.join('\n'));
    setProtectDraft(next.protect.join('\n'));
  }, []);

  /**
   * 切换同步模式。
   * @param enabled 是否启用知识库管理模式
   */
  const handleToggleMode = (enabled: boolean) => {
    persistKb({ ...kb, enabled });
    if (enabled && !kb.rootFolderId && folders.length > 0) {
      toast('请先指定「知识库根文件夹」');
    }
  };

  /**
   * 指定知识库根文件夹。
   * @param folderId 文件夹 ID；空字符串表示未选择
   */
  const handleSelectRoot = (folderId: string) => {
    const target = folders.find((f) => f.id === folderId);
    persistKb({
      ...kb,
      rootFolderId: folderId || null,
      rootFolderName: target?.name ?? '',
    });
  };

  /** 保存忽略清单与保护目录 */
  const handleSaveRules = () => {
    const toList = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    persistKb({ ...kb, ignore: toList(ignoreDraft), protect: toList(protectDraft) });
    toast.success('知识库规则已保存');
  };

  /** 恢复知识库预设规则 */
  const handleResetPreset = () => {
    persistKb({ ...kb, ignore: [...KB_PRESET_IGNORE], protect: [...KB_PRESET_PROTECT] });
    toast.success('已恢复知识库预设规则');
  };

  /** 把绑定目录中的 PDF / 文本登记到服务端并抽取正文 */
  const handleImportKbAssets = async () => {
    if (!handle || !granted) {
      toast.error('请先选择并授权本地文件夹');
      return;
    }
    setKbAssetBusy(true);
    try {
      let rootId = kbRootId;
      if (!rootId) {
        const root = await kbApi.ensureRoot(dirName || '本地知识库', kb.rootFolderId ?? undefined);
        rootId = root.id;
        setKbRootId(rootId);
      }
      const allFiles = await listAllFiles(handle, '', 5000);
      const candidates = allFiles.filter((path) => /\.(pdf|txt|md|csv|log|json|ya?ml|png|jpe?g|webp|bmp|tiff?)$/i.test(path));
      const fileMap = new Map<string, File>();
      const manifestFiles: Array<{ path: string; hash: string; size: number; mime?: string }> = [];
      for (const path of candidates) {
        const file = await readFile(handle, path);
        if (!file) continue;
        fileMap.set(path, file);
        const buffer = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const hash = Array.from(new Uint8Array(digest))
          .map(byte => byte.toString(16).padStart(2, '0'))
          .join('');
        manifestFiles.push({ path, hash, size: file.size, mime: file.type || undefined });
      }

      const plan = await kbApi.manifest(rootId, manifestFiles);
      let uploaded = 0;
      for (const path of plan.toUpload) {
        const file = fileMap.get(path);
        if (!file) continue;
        const isProtected = kb.protect.some((prefix) => {
          const normalized = prefix.replace(/\/$/, '');
          return path === normalized || path.startsWith(`${normalized}/`);
        });
        await kbApi.uploadFile(rootId, path, file, isProtected);
        uploaded += 1;
      }
      toast.success(`上传 ${uploaded} 个文件，跳过未变化 ${plan.unchanged} 个`);
      setKbAssets(await kbApi.listFiles(undefined, 30));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    } finally {
      setKbAssetBusy(false);
    }
  };

  /** 知识库资产 → Markdown 笔记（之后自动进入 RAG 索引） */
  const handleConvertKbFile = async (fileId: string) => {
    try {
      const result = await kbApi.convert(fileId);
      toast.success(`已生成笔记「${result.title}」`);
      bumpNotesRefresh();
      setKbAssets(await kbApi.listFiles(undefined, 30));
    } catch {
      toast.error('转换为笔记失败');
    }
  };

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
    async (
      mode: 'compare' | 'apply',
      target: SyncDirectoryHandle,
    ): Promise<SyncReport | null> => {
      if (!user?.id) {
        setError('未获取到当前用户信息，请重新登录后再试');
        return null;
      }
      setBusy(mode);
      setError('');
      setProgress(null);
      try {
        const result = await runSync(target, {
          mode,
          userId: user.id,
          direction,
          kb:
            direction === 'kb'
              ? {
                  rootFolderId: kb.rootFolderId,
                  rootFolderName: kb.rootFolderName,
                  ignore: kb.ignore,
                  protect: kb.protect,
                }
              : undefined,
          onProgress: setProgress,
        });
        setReport(result);
        await refreshEntries(target);
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
    [user?.id, refreshEntries, direction, kb],
  );

  /**
   * 执行同步。知识库模式下先跑一次只读比较并把计划列清，用户确认后才真正写盘
   * （对齐知识库红线：破坏性动作前先出计划）。
   */
  const handleApply = useCallback(async () => {
    if (!handle) return;
    if (direction === 'kb') {
      const preview = await run('compare', handle);
      if (!preview) return;
      const planned =
        preview.imported +
        preview.downloaded +
        preview.uploaded +
        preview.createdFolders.length +
        preview.uploadedFolders.length;
      if (planned === 0 && preview.errors.length === 0) {
        toast('没有需要同步的变更');
        return;
      }
      const lines = [
        '知识库模式本次将执行：',
        `· 导入新建 ${preview.imported} 篇`,
        `· 写回本地 ${preview.downloaded} 篇`,
        `· 更新服务端 ${preview.uploaded} 篇`,
        `· 新建文件夹 ${preview.createdFolders.length + preview.uploadedFolders.length} 个`,
        '',
        '不会删除任何本地文件，也不会覆盖有未同步修改的文件。',
        '',
        '确认执行？',
      ];
      if (!window.confirm(lines.join('\n'))) return;
    }
    await run('apply', handle);
  }, [handle, direction, run]);

  // 打开页面时恢复上次授权的目录，并在有权限的前提下自动对比一次
  useEffect(() => {
    if (!supported) return;
    void isPersistent().then(setPersistent);
    void refreshFolders();
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
  }, [supported, run, refreshEntries, refreshFolders]);

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
                onClick={() => void handleApply()}
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

        {/* 同步模式卡片 */}
        <div className={card}>
          <div className="p-5 space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-lg shadow-emerald-500/20">
                <Database className="w-4 h-4 text-white" />
              </div>
              <div>
                <h3 className={`text-sm font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                  同步模式
                </h3>
                <p className={`text-xs ${muted}`}>
                  决定本地文件夹与笔记树之间，谁说话算数
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => handleToggleMode(false)}
                className={`text-left rounded-xl border p-3 transition-colors ${
                  !kb.enabled
                    ? isDark
                      ? 'border-orange-600 bg-orange-950/30'
                      : 'border-orange-400 bg-orange-50'
                    : isDark
                      ? 'border-gray-700 hover:bg-gray-700/40'
                      : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <FolderSync size={15} className="text-orange-500 shrink-0" />
                  <span className={`text-sm font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                    通用镜像
                  </span>
                  {!kb.enabled && (
                    <CheckCircle2 size={13} className={isDark ? 'text-emerald-400' : 'text-emerald-600'} />
                  )}
                </div>
                <p className={`mt-1 text-xs ${muted}`}>
                  双向增量同步，冲突保留副本，删除进回收站
                </p>
              </button>
              <button
                type="button"
                onClick={() => handleToggleMode(true)}
                className={`text-left rounded-xl border p-3 transition-colors ${
                  kb.enabled
                    ? isDark
                      ? 'border-emerald-600 bg-emerald-950/30'
                      : 'border-emerald-400 bg-emerald-50'
                    : isDark
                      ? 'border-gray-700 hover:bg-gray-700/40'
                      : 'border-gray-200 hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <BookOpen size={15} className="text-emerald-500 shrink-0" />
                  <span className={`text-sm font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
                    知识库管理模式
                  </span>
                  {kb.enabled && (
                    <CheckCircle2 size={13} className={isDark ? 'text-emerald-400' : 'text-emerald-600'} />
                  )}
                </div>
                <p className={`mt-1 text-xs ${muted}`}>
                  本地文件为准，永不删除、永不覆盖，保护目录只导入
                </p>
              </button>
            </div>

            {kb.enabled && (
              <div
                className={`space-y-3 rounded-xl border p-3 ${
                  isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'
                }`}
              >
                {/* 知识库根文件夹 */}
                <div>
                  <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    知识库根文件夹
                  </label>
                  <select
                    value={kb.rootFolderId ?? ''}
                    onChange={(e) => handleSelectRoot(e.target.value)}
                    className={`w-full rounded-lg border px-2.5 py-2 text-sm outline-none ${
                      isDark
                        ? 'border-gray-700 bg-gray-800 text-gray-200'
                        : 'border-gray-200 bg-white text-gray-800'
                    }`}
                  >
                    <option value="">（未选择 —— 必须指定后才能启用）</option>
                    {folders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {folderLabel(f.id, folders) || f.name}
                      </option>
                    ))}
                  </select>
                  <p className={`mt-1 text-xs ${muted}`}>
                    绑定目录与该文件夹建立映射；只有它下面的笔记参与同步，其余笔记不受影响。
                  </p>
                </div>

                {/* 忽略清单 */}
                <div>
                  <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    忽略清单（一行一条，相对知识库根）
                  </label>
                  <textarea
                    value={ignoreDraft}
                    onChange={(e) => setIgnoreDraft(e.target.value)}
                    rows={6}
                    spellCheck={false}
                    className={`w-full rounded-lg border px-2.5 py-2 font-mono text-xs outline-none ${
                      isDark
                        ? 'border-gray-700 bg-gray-800 text-gray-200'
                        : 'border-gray-200 bg-white text-gray-800'
                    }`}
                  />
                  <p className={`mt-1 text-xs ${muted}`}>
                    <code>/AGENTS.md</code> 只匹配根目录；<code>archive/2025</code> 匹配该子树；
                    <code>templates</code> 匹配任意层级的同名项。点开头的文件由系统自动跳过。
                  </p>
                </div>

                {/* 保护目录 */}
                <div>
                  <label className={`flex items-center gap-1.5 text-xs font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                    <ShieldCheck size={13} className="text-emerald-500" />
                    保护目录（只导入，禁止写回与删除）
                  </label>
                  <textarea
                    value={protectDraft}
                    onChange={(e) => setProtectDraft(e.target.value)}
                    rows={3}
                    spellCheck={false}
                    className={`w-full rounded-lg border px-2.5 py-2 font-mono text-xs outline-none ${
                      isDark
                        ? 'border-gray-700 bg-gray-800 text-gray-200'
                        : 'border-gray-200 bg-white text-gray-800'
                    }`}
                  />
                  <p className={`mt-1 text-xs ${muted}`}>
                    对齐知识库 AGENTS.md 权限表：<code>raw/</code> 与 <code>templates/</code> 的原始资料
                    永远不会被应用改写。这是第二道保险，即使忽略清单改错也伤不到源文件。
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={handleSaveRules}
                    className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
                  >
                    <Save size={13} />
                    保存规则
                  </button>
                  <button
                    type="button"
                    onClick={handleResetPreset}
                    className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                      isDark
                        ? 'border-gray-700 text-gray-300 hover:bg-gray-700'
                        : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                    }`}
                  >
                    恢复知识库预设
                  </button>
                </div>

                {kb.enabled && !kb.rootFolderId && (
                  <div
                    className={`flex items-start gap-2 rounded-lg border p-2.5 text-xs ${
                      isDark
                        ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                        : 'border-amber-200 bg-amber-50 text-amber-700'
                    }`}
                  >
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      还未指定知识库根文件夹，当前同步仍按「通用镜像」执行。选好根文件夹后才会切换到知识库模式。
                    </span>
                  </div>
                )}
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
                {report.direction === 'kb' && (
                  <Stat label="导入新建" value={report.imported} isDark={isDark} />
                )}
                <Stat
                  label={report.direction === 'kb' ? '写回本地' : '下载到本地'}
                  value={report.downloaded}
                  isDark={isDark}
                />
                <Stat
                  label={report.direction === 'kb' ? '更新服务端' : '上传到服务端'}
                  value={report.uploaded}
                  isDark={isDark}
                />
                {report.direction !== 'kb' && (
                  <>
                    <Stat label="冲突副本" value={report.conflicts.length} isDark={isDark} />
                    <Stat label="本地删除同步" value={report.localDeleted.length} isDark={isDark} />
                    <Stat
                      label="远端删除移入回收站"
                      value={report.remoteDeleted.length}
                      isDark={isDark}
                    />
                  </>
                )}
                <Stat label="新建文件夹" value={report.uploadedFolders.length} isDark={isDark} />
                <Stat label="跳过加密文档" value={report.skippedEncrypted} isDark={isDark} />
                {report.direction === 'kb' && (
                  <Stat label="跳过非文本文件" value={report.skippedUnsupported} isDark={isDark} />
                )}
              </div>

              {report.direction === 'kb' && (
                <div
                  className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
                    isDark
                      ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
                      : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  }`}
                >
                  <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    知识库模式：本次运行未删除任何本地文件，未覆盖任何有未同步修改的文件。
                  </span>
                </div>
              )}

              {report.missingLocal.length > 0 && (
                <PathList
                  title="本地文件已消失（服务端笔记已保留，未删除）"
                  items={report.missingLocal}
                  isDark={isDark}
                />
              )}
              {report.unlinkedLocal.length > 0 && (
                <PathList
                  title="远端笔记已删除（本地文件已保留，仅解除映射）"
                  items={report.unlinkedLocal}
                  isDark={isDark}
                />
              )}
              {report.blockedByProtection.length > 0 && (
                <PathList
                  title="命中保护目录，已拒绝写回"
                  items={report.blockedByProtection}
                  isDark={isDark}
                />
              )}
              {report.skippedRemoteChanges.length > 0 && (
                <PathList
                  title="两端都改过：已以本地为准，远端变更未生效"
                  items={report.skippedRemoteChanges}
                  isDark={isDark}
                />
              )}

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

        {/* 知识库资产 */}
        <div className={card}>
          <div className="p-5">
            <h3 className={`text-sm font-bold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
              知识库资产（PDF / 文本）
            </h3>
            <p className={`text-xs mb-3 ${muted}`}>
              把绑定目录中的 PDF、文本与图片登记到服务端并抽取正文（图片走本地 OCR）。转为笔记后会自动进入语义索引，可被 AI 检索与引用。
              本地文件不会被修改或删除。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleImportKbAssets()}
                disabled={kbAssetBusy || !handle || !granted}
                className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {kbAssetBusy ? '登记中…' : '登记目录中的资产'}
              </button>
              <span className={`text-[11px] ${muted}`}>已登记 {kbAssets.length} 个文件</span>
            </div>
            {kbAssets.length > 0 && (
              <ul className={`mt-3 space-y-1.5 text-xs ${muted}`}>
                {kbAssets.map((asset) => (
                  <li key={asset.id} className="flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate" title={asset.path}>
                      {asset.isProtected ? '🔒 ' : ''}{asset.path}
                      <span className="ml-1 opacity-60">
                        {asset.status === 'extract_failed' ? '· 无可提取文本' : asset.hasText ? '· 已抽取' : ''}
                      </span>
                    </span>
                    {asset.noteId ? (
                      <span className="shrink-0 text-[10px] text-green-600">已转笔记</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void handleConvertKbFile(asset.id)}
                        className="shrink-0 text-[10px] text-orange-600 hover:underline"
                      >
                        转为笔记
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* 说明 */}
        <div className={card}>
          <div className="p-5">
            <h3 className={`text-sm font-bold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
              同步说明
            </h3>
            <ul className={`space-y-1.5 text-xs ${muted}`}>
              {kb.enabled ? (
                <>
                  <li>· <b>本地文件是事实源</b>：同步只把本地内容推进数据库，不会删除任何本地文件。</li>
                  <li>· 只有「本地未改动」的笔记才会被写回；有未同步修改的文件永不被覆盖。</li>
                  <li>· 两端都改过时以本地为准，远端变更会列在报告里，不生成冲突副本。</li>
                  <li>· 保护目录（<code>raw/</code>、<code>templates/</code>）只导入，永不写回。</li>
                  <li>· 在应用内新建的笔记会写入绑定目录，位置按知识库根文件夹的层级还原。</li>
                  <li>· 磁盘文件被改名或搬走后，应用会按内容指纹认领，不会重复导入。</li>
                  <li>· frontmatter 的未知字段（<code>type</code> / <code>sources</code> / <code>related</code> 等）原样保留。</li>
                  <li>· 同步状态记录在 <code>.aidrivenote/sync.json</code>，它就是文件与笔记的映射表。</li>
                </>
              ) : (
                <>
                  <li>· Markdown 笔记带 YAML frontmatter（含 adn_id/title/tags/folder），JSON 与 drawio 保持原生格式。</li>
                  <li>· 笔记内嵌图片以 base64 内联在文件中，不需要也不支持单独抽离为图片文件。</li>
                  <li>· AI 聊天附件不在同步范围内（它们挂在会话上，不属于笔记）。</li>
                  <li>· 服务端删除笔记时，本地文件会移入 <code>.aidrivenote/trash/</code>，不会真正删除。</li>
                  <li>· 本地删除文件时，服务端笔记走软删除，可在回收站中恢复。</li>
                  <li>· 两端都改过同一条笔记时，本地修改会另存为 <code>标题.conflict-时间戳.扩展名</code> 副本。</li>
                  <li>· 同步状态记录在 <code>.aidrivenote/sync.json</code>；删除它只影响差异判断，不会丢数据。</li>
                </>
              )}
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