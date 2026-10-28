import React, { useCallback, useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  FolderSync,
  ShieldCheck,
} from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { useAuth } from '../../contexts/AuthContext';
import { noteFolderApi, type NoteFolder } from '../../services/note';
import {
  isPersistent,
  isSupported,
  listAllFiles,
  readFile,
} from '../../services/sync/folderAccess';
import {
  KB_PRESET_IGNORE,
  KB_PRESET_PROTECT,
  loadSyncConfig,
  saveSyncConfig,
  type SyncConfig,
  type SyncSourceKey,
} from '../../services/sync/kbConfig';
import { kbApi, type KbFileInfo, type KnowledgeRootInfo } from '../../services/kb';
import { useSyncSource } from './useSyncSource';
import SyncSourceCard from './SyncSourceCard';

/** 知识库本地目录的推荐位置（浏览器无法自动打开绝对路径，仅作提示） */
const KB_LOCAL_PATH_HINT = '~/Documents/KnowledgeBase/';

/**
 * 本地同步设置页 —— 两个互相独立的同步源。
 *
 * 1. 知识库同步：本机知识库目录 ↔ 笔记树根级「知识库」系统文件夹；
 * 2. 笔记同步：用户自选本地文件夹 ↔ 整棵笔记树（自动排除知识库子树）。
 *
 * 每个源各自持有目录授权、manifest、规则与同步报告，互不影响。
 */
const SyncSettingsPage: React.FC = () => {
  const { theme, bumpNotesRefresh } = useApp();
  const { user } = useAuth();
  const isDark = theme === 'dark';
  const supported = useMemo(() => isSupported(), []);

  const [cfg, setCfg] = useState<SyncConfig>(() => loadSyncConfig());
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [persistent, setPersistent] = useState<boolean | null>(null);

  const [kbRootId, setKbRootId] = useState<string | null>(null);
  const [kbAssets, setKbAssets] = useState<KbFileInfo[]>([]);
  const [kbAssetBusy, setKbAssetBusy] = useState(false);
  /** 两个本地目录互相包含时的提醒（如笔记目录选了 ~/Documents） */
  const [nestWarning, setNestWarning] = useState('');

  const notes = useSyncSource('notes');
  const kb = useSyncSource('kb');
  const { load: loadNotes } = notes;
  const { load: loadKb } = kb;

  const card = 'bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm';
  const muted = isDark ? 'text-gray-400' : 'text-gray-500';

  /** 写入配置并持久化 */
  const persist = useCallback((next: SyncConfig) => {
    setCfg(next);
    saveSyncConfig(next);
  }, []);

  /** 更新单个同步源的配置 */
  const patchSource = useCallback(
    (key: SyncSourceKey, patch: Partial<SyncConfig[SyncSourceKey]>) => {
      setCfg((prev) => {
        const next: SyncConfig = { ...prev, [key]: { ...prev[key], ...patch } };
        saveSyncConfig(next);
        return next;
      });
    },
    [],
  );

  /** 读取笔记文件夹列表（用于展示知识库根状态） */
  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await noteFolderApi.list());
    } catch {
      setFolders([]);
    }
  }, []);

  // 恢复两个源各自的目录授权
  useEffect(() => {
    if (!supported) return;
    void isPersistent().then(setPersistent);
    void refreshFolders();
    void loadNotes();
    void loadKb();
  }, [supported, refreshFolders, loadNotes, loadKb]);

  // 检测两个本地目录是否互相包含：互相包含会让两个同步源扫描到对方的内容
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      if (!notes.handle || !kb.handle) {
        if (!cancelled) setNestWarning('');
        return;
      }
      try {
        const kbInNotes = await notes.handle.resolve(kb.handle);
        if (kbInNotes && kbInNotes.length === 0) {
          if (!cancelled) {
            setNestWarning('两个同步源绑定了同一个文件夹。请为知识库与笔记分别选择独立目录，否则两边会互相覆盖对方的状态文件。');
          }
          return;
        }
        if (kbInNotes && kbInNotes.length > 0) {
          if (!cancelled) {
            setNestWarning(
              `笔记文件夹包含了知识库目录「${kbInNotes.join('/')}」。建议为笔记同步选择一个独立文件夹，避免两个源互相扫描。`,
            );
          }
          return;
        }
        const notesInKb = await kb.handle.resolve(notes.handle);
        if (notesInKb && notesInKb.length > 0) {
          if (!cancelled) {
            setNestWarning(
              `知识库目录包含了笔记文件夹「${notesInKb.join('/')}」。建议为两者选择互不包含的文件夹。`,
            );
          }
          return;
        }
        if (!cancelled) setNestWarning('');
      } catch {
        if (!cancelled) setNestWarning('');
      }
    };
    void check();
    return () => {
      cancelled = true;
    };
  }, [notes.handle, kb.handle]);

  // 读取知识库资产
  useEffect(() => {
    void (async () => {
      try {
        const roots = await kbApi.listRoots();
        const primary = roots.find((root) => root.folderId) ?? roots[0];
        if (primary) {
          setKbRootId(primary.id);
          setKbAssets(await kbApi.listFiles(undefined, 30));
        }
      } catch {
        /* 未登录/网络异常时静默 */
      }
    })();
  }, []);

  /**
   * 确保笔记树根级「知识库」系统文件夹存在，并写回配置。
   * @returns 根信息；失败时返回 null
   */
  const ensureKbRoot = useCallback(async (): Promise<KnowledgeRootInfo | null> => {
    try {
      const info = await kbApi.ensureKnowledgeRoot();
      setKbRootId(info.rootId);
      patchSource('kb', { rootFolderId: info.folderId, rootFolderName: info.folderName });
      await refreshFolders();
      bumpNotesRefresh();
      return info;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建知识库根文件夹失败');
      return null;
    }
  }, [patchSource, refreshFolders, bumpNotesRefresh]);

  /** 切换同步源的一键同步开关 */
  const handleToggle = useCallback(
    async (key: SyncSourceKey, enabled: boolean) => {
      if (key === 'kb' && enabled && !cfg.kb.rootFolderId) {
        const info = await ensureKbRoot();
        if (!info) return;
      }
      patchSource(key, { enabled });
      const runtime = key === 'notes' ? notes : kb;
      if (enabled && !runtime.handle) {
        toast(`请先选择${key === 'kb' ? '本地知识库' : '笔记'}文件夹`);
      }
    },
    [cfg.kb.rootFolderId, ensureKbRoot, patchSource, notes, kb],
  );

  /** 组装通用参数 */
  const baseOptions = useCallback(() => {
    if (!user?.id) {
      toast.error('未获取到当前用户信息，请重新登录后再试');
      return null;
    }
    return { userId: user.id };
  }, [user?.id]);

  /** 笔记源参数：整棵笔记树，排除知识库子树 */
  const notesOptions = useCallback(() => {
    const base = baseOptions();
    if (!base) return null;
    return {
      ...base,
      direction: 'two-way' as const,
      excludeFolderIds: cfg.kb.rootFolderId ? [cfg.kb.rootFolderId] : [],
    };
  }, [baseOptions, cfg.kb.rootFolderId]);

  /** 知识库源参数 */
  const kbOptions = useCallback(() => {
    const base = baseOptions();
    if (!base) return null;
    const rootFolderId = cfg.kb.rootFolderId;
    if (!rootFolderId) {
      toast.error('尚未创建知识库根文件夹');
      return null;
    }
    return {
      ...base,
      direction: 'kb' as const,
      kb: {
        rootFolderId,
        rootFolderName: cfg.kb.rootFolderName,
        ignore: cfg.kb.ignore,
        protect: cfg.kb.protect,
      },
    };
  }, [baseOptions, cfg.kb.rootFolderId, cfg.kb.rootFolderName, cfg.kb.ignore, cfg.kb.protect]);

  /** 笔记源：只读对比 */
  const handleCompareNotes = useCallback(async () => {
    const opts = notesOptions();
    if (!opts) return;
    await notes.run('compare', opts);
  }, [notes, notesOptions]);

  /** 笔记源：执行同步 */
  const handleApplyNotes = useCallback(async () => {
    const opts = notesOptions();
    if (!opts) return;
    const result = await notes.run('apply', opts);
    if (result) bumpNotesRefresh();
  }, [notes, notesOptions, bumpNotesRefresh]);

  /** 知识库源：只读对比 */
  const handleCompareKb = useCallback(async () => {
    const opts = kbOptions();
    if (!opts) return;
    await kb.run('compare', opts);
  }, [kb, kbOptions]);

  /**
   * 知识库源：先只读比较并列出计划，用户确认后才写盘
   * （对齐知识库红线：破坏性动作前先出计划）。
   */
  const handleApplyKb = useCallback(async () => {
    const opts = kbOptions();
    if (!opts) return;
    const preview = await kb.run('compare', opts);
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
      '知识库同步本次将执行：',
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
    const result = await kb.run('apply', opts);
    if (result) bumpNotesRefresh();
  }, [kb, kbOptions, bumpNotesRefresh]);

  /** 把知识库目录中的 PDF / Office / 文本登记到服务端 */
  const handleImportKbAssets = async () => {
    if (!kb.handle || !kb.granted) {
      toast.error('请先绑定并授权本地知识库文件夹');
      return;
    }
    setKbAssetBusy(true);
    try {
      let rootId = kbRootId;
      if (!rootId) {
        const info = await ensureKbRoot();
        if (!info) return;
        rootId = info.rootId;
      }
      const allFiles = await listAllFiles(kb.handle, '', 5000);
      const candidates = allFiles
        .filter((path) =>
          /\.(pdf|docx?|xlsx?|pptx?|html?|txt|md|csv|log|json|ya?ml|png|jpe?g|webp|bmp|tiff?)$/i.test(path),
        )
        .slice(0, 200);
      const fileMap = new Map<string, File>();
      const manifestFiles: Array<{ path: string; hash: string; size: number; mime?: string }> = [];
      let skippedLarge = 0;
      for (const path of candidates) {
        const file = await readFile(kb.handle, path);
        if (!file) continue;
        if (file.size > 50 * 1024 * 1024) {
          skippedLarge += 1;
          continue;
        }
        fileMap.set(path, file);
        const buffer = await file.arrayBuffer();
        const digest = await crypto.subtle.digest('SHA-256', buffer);
        const hash = Array.from(new Uint8Array(digest))
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
        manifestFiles.push({ path, hash, size: file.size, mime: file.type || undefined });
      }

      const plan = await kbApi.manifest(rootId, manifestFiles);
      let uploaded = 0;
      for (const path of plan.toUpload) {
        const file = fileMap.get(path);
        if (!file) continue;
        const isProtected = cfg.kb.protect.some((prefix) => {
          const normalized = prefix.replace(/\/$/, '');
          return path === normalized || path.startsWith(`${normalized}/`);
        });
        await kbApi.uploadFile(rootId, path, file, isProtected);
        uploaded += 1;
      }
      toast.success(`上传 ${uploaded} 个文件，跳过未变化 ${plan.unchanged} 个`);
      if (skippedLarge > 0) {
        toast(`另有 ${skippedLarge} 个文件超过 50MB 已跳过`);
      }
      setKbAssets(await kbApi.listFiles(undefined, 30));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    } finally {
      setKbAssetBusy(false);
    }
  };

  /** 知识库资产 → 文档笔记 / Markdown 笔记（之后自动进入 RAG 索引） */
  const handleConvertKbFile = async (fileId: string) => {
    try {
      const result = await kbApi.convert(fileId);
      toast.success(
        result.noteType === 'document'
          ? `已生成文档笔记「${result.title}」`
          : `已生成笔记「${result.title}」`,
      );
      bumpNotesRefresh();
      setKbAssets(await kbApi.listFiles(undefined, 30));
    } catch {
      toast.error('转换为笔记失败');
    }
  };

  const handleDownloadKbFile = async (fileId: string, path: string) => {
    try {
      await kbApi.downloadFile(fileId, path.split('/').pop() || 'document');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下载失败');
    }
  };

  const kbRootFolder = cfg.kb.rootFolderId
    ? folders.find((f) => f.id === cfg.kb.rootFolderId)
    : undefined;

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
                  <p className={`text-sm ${muted}`}>两个独立根目录：知识库与笔记</p>
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
        {/* 头部说明 */}
        <div className={card}>
          <div className="p-5">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-orange-600 flex items-center justify-center shadow-lg shadow-orange-500/20">
                <FolderSync className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900 dark:text-white">本地同步</h2>
                <p className={`text-sm ${muted}`}>
                  两个互相独立的根目录，各自绑定、各自同步、互不干扰
                </p>
              </div>
            </div>
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className={`rounded-xl border p-3 ${isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'}`}>
                <div className="flex items-center gap-2">
                  <BookOpen size={15} className="text-emerald-500" />
                  <span className={`text-sm font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>知识库同步</span>
                </div>
                <p className={`mt-1 text-xs ${muted}`}>
                  {KB_LOCAL_PATH_HINT} ↔ 根级「知识库」文件夹（系统保护，不可删除）
                </p>
              </div>
              <div className={`rounded-xl border p-3 ${isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'}`}>
                <div className="flex items-center gap-2">
                  <FolderSync size={15} className="text-orange-500" />
                  <span className={`text-sm font-medium ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>笔记同步</span>
                </div>
                <p className={`mt-1 text-xs ${muted}`}>
                  自选本地文件夹 ↔ 整棵笔记树（自动排除「知识库」子树）
                </p>
              </div>
            </div>
            {nestWarning && (
              <div
                className={`mt-3 flex items-start gap-2 rounded-xl border p-3 text-xs ${
                  isDark
                    ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{nestWarning}</span>
              </div>
            )}
          </div>
        </div>

        {/* 知识库同步源 */}
        <SyncSourceCard
          sourceKey="kb"
          title="知识库同步"
          subtitle="本机知识库目录与笔记树中的知识库根文件夹双向同步"
          icon={<BookOpen className="w-5 h-5 text-white" />}
          accent="emerald"
          config={cfg.kb}
          runtime={kb}
          isDark={isDark}
          supported={supported}
          persistent={persistent}
          pickStartIn="documents"
          pathHint={KB_LOCAL_PATH_HINT}
          onToggle={(enabled) => void handleToggle('kb', enabled)}
          onSaveRules={(ignore, protect) => {
            patchSource('kb', { ignore, protect });
            toast.success('知识库规则已保存');
          }}
          onResetPreset={() => {
            patchSource('kb', { ignore: [...KB_PRESET_IGNORE], protect: [...KB_PRESET_PROTECT] });
            toast.success('已恢复知识库预设规则');
          }}
          onCompare={() => void handleCompareKb()}
          onApply={() => void handleApplyKb()}
          scopeSlot={
            <div
              className={`rounded-xl border p-3 text-xs ${
                kbRootFolder
                  ? isDark
                    ? 'border-emerald-900/60 bg-emerald-950/30 text-emerald-300'
                    : 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : isDark
                    ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                    : 'border-amber-200 bg-amber-50 text-amber-700'
              }`}
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <span className="flex items-center gap-1.5">
                  <ShieldCheck size={13} />
                  {kbRootFolder ? (
                    <>知识库根文件夹：<b>{kbRootFolder.name}</b>（系统保护，不可删除）</>
                  ) : cfg.kb.rootFolderId ? (
                    <>找不到知识库根文件夹，可能已被删除，请重新创建</>
                  ) : (
                    <>尚未创建知识库根文件夹；启用同步或点击右侧按钮自动创建</>
                  )}
                </span>
                {!kbRootFolder && (
                  <button
                    type="button"
                    onClick={() => void ensureKbRoot()}
                    className="rounded-lg border border-current px-2 py-1 text-[11px] font-medium"
                  >
                    创建根文件夹
                  </button>
                )}
              </div>
            </div>
          }
        >
          {/* 知识库资产 */}
          <div className={`rounded-xl border p-3 ${isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50'}`}>
            <h4 className={`text-xs font-bold mb-1.5 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
              知识库资产（PDF / Office / HTML / 文本）
            </h4>
            <p className={`text-xs mb-2 ${muted}`}>
              把知识库目录中的 PDF、Word、Excel、PPT、HTML、文本与图片登记到服务端：
              可预览格式会保留原文件，转为笔记后可直接在应用内查看；正文同时进入语义索引。
              本地文件不会被修改或删除。
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handleImportKbAssets()}
                disabled={kbAssetBusy || !kb.handle || !kb.granted}
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
                      {asset.isProtected ? '🔒 ' : ''}
                      {asset.path}
                      <span className="ml-1 opacity-60">
                        {asset.viewable
                          ? '· 可预览'
                          : asset.status === 'extract_failed'
                            ? '· 无可提取文本'
                            : asset.hasText
                              ? '· 已抽取'
                              : ''}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {asset.viewable && (
                        <button
                          type="button"
                          onClick={() => void handleDownloadKbFile(asset.id, asset.path)}
                          className="text-[10px] text-gray-500 hover:underline"
                        >
                          下载
                        </button>
                      )}
                      {asset.noteId ? (
                        <span className="text-[10px] text-green-600">已转笔记</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => void handleConvertKbFile(asset.id)}
                          className="text-[10px] text-orange-600 hover:underline"
                        >
                          {asset.viewable ? '查看文档' : '转为笔记'}
                        </button>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </SyncSourceCard>

        {/* 笔记同步源 */}
        <SyncSourceCard
          sourceKey="notes"
          title="笔记同步"
          subtitle="自选本地文件夹与整棵笔记树双向增量镜像"
          icon={<FolderSync className="w-5 h-5 text-white" />}
          accent="orange"
          config={cfg.notes}
          runtime={notes}
          isDark={isDark}
          supported={supported}
          persistent={persistent}
          onToggle={(enabled) => void handleToggle('notes', enabled)}
          onSaveRules={(ignore, protect) => {
            patchSource('notes', { ignore, protect });
            toast.success('笔记同步规则已保存');
          }}
          onCompare={() => void handleCompareNotes()}
          onApply={() => void handleApplyNotes()}
          scopeSlot={
            <div
              className={`rounded-xl border p-3 text-xs ${
                isDark ? 'border-gray-700 bg-gray-900/40 text-gray-300' : 'border-gray-200 bg-gray-50 text-gray-600'
              }`}
            >
              同步范围：整棵笔记树。{cfg.kb.rootFolderId ? '「知识库」文件夹及其子树由知识库同步独占，不会重复出现在这里。' : '尚未创建知识库根文件夹，当前为全量镜像。'}
            </div>
          }
        />

        {/* 说明 */}
        <div className={card}>
          <div className="p-5">
            <h3 className={`text-sm font-bold mb-2 ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
              同步说明
            </h3>
            <ul className={`space-y-1.5 text-xs ${muted}`}>
              <li>· 两个同步源各自保存目录授权与 <code>.aidrivenote/sync.json</code>，可以绑定不同磁盘目录。</li>
              <li>· <b>知识库根文件夹</b>位于笔记树根级，由应用创建并标记为系统文件夹，不能删除或移动。</li>
              <li>· 知识库源以本地文件为准：永不删除本地文件，也永不覆盖有未同步修改的文件。</li>
              <li>· 知识库源中，保护目录（<code>raw/</code>、<code>templates/</code>）只导入，永不写回。</li>
              <li>· 笔记源为双向镜像：冲突保留副本，删除进 <code>.aidrivenote/trash/</code> 或服务端回收站。</li>
              <li>· 笔记源会自动跳过知识库子树，避免同一篇笔记被镜像到两个目录。</li>
              <li>· 磁盘文件被改名或搬走后，知识库源会按内容指纹认领，不会重复导入。</li>
            </ul>
          </div>
        </div>

        {/* 底部提示 */}
        <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
          isDark ? 'border-gray-700 bg-gray-900/40 text-gray-400' : 'border-gray-200 bg-gray-50 text-gray-500'
        }`}>
          <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-emerald-500" />
          <span>
            浏览器无法自动读取绝对路径：绑定 <code className="mx-0.5">{KB_LOCAL_PATH_HINT}</code>
            时会从「文稿」目录开始，请选中 <code className="mx-0.5">KnowledgeBase</code> 文件夹。
            该目录与其他应用共享，知识库同步只会写入受管文件。
          </span>
        </div>
      </div>
    </div>
  );
};

export default SyncSettingsPage;
