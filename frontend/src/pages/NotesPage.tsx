/**
 * NotesPage – AIDriveNote 笔记管理（两栏布局）
 *
 * 左侧笔记列表面板（含文件夹树、分类筛选）+ 右侧编辑器面板
 * 支持可拖拽调整宽度、全屏模式、暗色主题、文件夹管理
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  FileText,
  Code2, Brain, GitFork, PanelLeftOpen, Plus, FileType, Upload,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../contexts/AppContext';
import { useAuth } from '../contexts/AuthContext';
import { useIsMobile } from '../hooks/useMobile';
import {
  clampNumber,
  isStringArray,
  usePersistentState,
  usePersistentStateDebounced,
} from '../hooks/usePersistentState';
import { buildNoteQuickActions } from '../utils/noteAIActions';
import { isNetworkError } from '../services/client';
import {
  noteApi, noteDocumentApi, noteFolderApi, noteTemplateApi, noteTagApi, noteLockApi,
  setUnlockToken, clearUnlockToken,
  type Note, type NoteCreate, type NoteUpdate, type NoteFolder, type NoteTag, type LockScope,
} from '../services/note';
import {
  cacheList, cacheNoteMetas, dropCached, readAllNotes, readList, readNote, stripCachedContent, toNote,
} from '../services/offline/noteCache';
import {
  createOfflineNote, deleteOfflineNote, saveOfflineEdit,
} from '../services/offline/offlineQueue';
import type { OutboxPayload } from '../services/offline/offlineDb';
import NoteListPanel, { type NoteCategory } from '../components/note/NoteListPanel';
import NoteEditorPanel from '../components/note/NoteEditorPanel';
import NoteTemplateGallery from '../components/note/NoteTemplateGallery';
import NoteQuickSwitcher from '../components/note/NoteQuickSwitcher';
import GlobalCommandPalette from '../components/note/GlobalCommandPalette';
import QuickCaptureDialog from '../components/note/QuickCaptureDialog';
import PasswordDialog, { type PasswordDialogMode } from '../components/note/PasswordDialog';
import ConfirmDialog from '../components/ConfirmDialog';

/** 页面级确认框状态：替代原生 confirm()，避免样式不可控与被浏览器拦截 */
interface ConfirmState {
  title: string;
  message: string;
  confirmLabel?: string;
  variant?: 'danger' | 'warning' | 'info';
  action: () => void | Promise<void>;
}

/**
 * 加密文档对话框的上下文。
 * kind 决定调用笔记接口还是文件夹接口；tokenScope/tokenId 决定解锁票据挂到哪个保护域
 * （笔记自身加密时为 note，受文件夹保护时为空文件夹 ID）。
 */
interface LockDialogState {
  /** 操作对象类型：笔记 / 文件夹 */
  kind: 'note' | 'folder';
  /** 触发的操作 */
  action: 'encrypt' | 'unlock' | 'decrypt' | 'changePassword';
  /** 接口目标 ID（笔记 ID 或文件夹 ID） */
  targetId: string;
  /** 解锁票据的 scope */
  tokenScope: LockScope;
  /** 解锁票据的对象 ID */
  tokenId: string;
  /** 对话框标题 */
  title: string;
}

const NotesPage: React.FC = () => {
  const { theme, setPageAIContext, bumpNotesRefresh, notesRefreshToken, openAI } = useApp();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const isDark = theme === 'dark';
  // 移动端：窄屏自动切换为单列布局（列表与编辑器互斥全宽显示）
  const isMobile = useIsMobile();

  // Notes data
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [loading, setLoading] = useState(false);
  // 搜索词高频变化，用防抖版本落盘
  const [searchQuery, setSearchQuery] = usePersistentStateDebounced<string>('note_search_query', '');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  // 筛选与视图偏好持久化：刷新后无需重建视图
  const [filterType, setFilterType] = usePersistentState<string>('note_filter_type', 'all');
  const [selectedTagIds, setSelectedTagIds] = usePersistentState<string[]>(
    'note_filter_tags',
    [],
    isStringArray,
  );
  const [allTags, setAllTags] = useState<NoteTag[]>([]);
  const [notesTotal, setNotesTotal] = useState(0);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  /* ────── 路由 ↔ 笔记深链 ──────
   *
   * /note/:noteId 是笔记的唯一地址：可收藏、可多标签页、可被 AI 引用跳转。
   * 列表切换只改 URL；刷新 / 直达 / 前进后退由 URL 反推选中笔记。
   */
  const navigate = useNavigate();
  const { noteId: routeNoteId } = useParams<{ noteId: string }>();
  const [searchParams] = useSearchParams();
  /** AI 引用跳转携带的块 id（/note/:id?chunk=...） */
  const citationChunkId = searchParams.get('chunk');
  /** 当前打开笔记 id 镜像，供异步回调读取最新值 */
  const selectedNoteIdRef = useRef<string | null>(null);
  /** 笔记列表镜像，供路由同步按 id 查找笔记 */
  const notesRef = useRef<Note[]>(notes);
  notesRef.current = notes;
  /** 曾经打开过笔记：用于区分"主动关闭"与"深链首次挂载尚未加载" */
  const hadSelectedNoteRef = useRef(false);

  /** 选中笔记 → URL：列表内切换用 replace，避免历史里堆积一长串笔记 */
  useEffect(() => {
    selectedNoteIdRef.current = selectedNote?.id ?? null;
    if (!selectedNote) {
      // 首次挂载时 URL 可能自带 noteId（深链/刷新），此时不能重定向回首页，
      // 交给下面的「URL → 选中笔记」effect 去加载。
      if (hadSelectedNoteRef.current && routeNoteId) navigate('/', { replace: true });
      hadSelectedNoteRef.current = false;
      return;
    }
    hadSelectedNoteRef.current = true;
    if (routeNoteId === selectedNote.id) return;
    navigate(`/note/${selectedNote.id}`, { replace: Boolean(routeNoteId) });
  }, [selectedNote, routeNoteId, navigate]);

  /** URL → 选中笔记：支持深链与前进/后退；不在当前筛选结果里时按 id 补拉 */
  useEffect(() => {
    if (!routeNoteId) {
      if (selectedNoteIdRef.current) setSelectedNote(null);
      return;
    }
    if (selectedNoteIdRef.current === routeNoteId) return;

    const target = notesRef.current.find(n => n.id === routeNoteId);
    if (target) {
      setSelectedNote(target);
      localStorage.setItem('note_last_opened_id', target.id);
      return;
    }

    let cancelled = false;
    void (async () => {
      const cached = await readNote(routeNoteId);
      let resolved: Note | null = cached ? toNote(cached) : null;
      if (!resolved) {
        try {
          resolved = await noteApi.get(routeNoteId);
        } catch {
          resolved = null;
        }
      }
      if (cancelled) return;
      if (resolved) {
        setSelectedNote(resolved);
        localStorage.setItem('note_last_opened_id', resolved.id);
      } else {
        toast.error('笔记不存在或已被删除');
        navigate('/', { replace: true });
      }
    })();
    return () => { cancelled = true; };
  }, [routeNoteId, notes.length, navigate]);

  /** 关闭当前笔记：回到列表地址 */
  const handleCloseNote = useCallback(() => {
    setSelectedNote(null);
    if (routeNoteId) navigate('/');
  }, [navigate, routeNoteId]);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorRefreshTrigger, setEditorRefreshTrigger] = useState(0);
  const [showNewNotePopover, setShowNewNotePopover] = useState(false);
  /** 快速切换器（⌘P）开关：与命令面板（⌘K）职责分离，一个定位笔记，一个执行命令 */
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  /** 统一 ⌘K 面板：笔记检索 + 最近笔记 + 全局操作 */
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const [showQuickCapture, setShowQuickCapture] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  /** 加密/解锁/取消加密/改密 对话框上下文；null 表示关闭 */
  const [lockDialog, setLockDialog] = useState<LockDialogState | null>(null);
  // 当前分类页签持久化（folder 视图依赖具体 folderId，不持久化）
  const [storedCategoryType, setStoredCategoryType] = usePersistentState<NoteCategory['type']>(
    'note_category_type',
    'all',
  );
  const [selectedCategory, setSelectedCategory] = useState<NoteCategory>(
    () => (storedCategoryType === 'folder' ? { type: 'all' } : { type: storedCategoryType }),
  );
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 侧栏宽度可调区间（拖拽与持久化共用，避免两处写死不同数字）
  const MIN_LEFT_WIDTH = 240;
  const MAX_LEFT_WIDTH = 600;

  // Sidebar width (draggable) —— 持久化，刷新后保持用户调好的宽度
  const [storedLeftWidth, setLeftWidth] = usePersistentStateDebounced<number>('note_sidebar_width', 320, 300);
  // 持久化的宽度可能来自旧版本或被手工改坏，统一夹到合法区间后再用于渲染
  const leftWidth = clampNumber(storedLeftWidth, MIN_LEFT_WIDTH, MAX_LEFT_WIDTH, 320);
  // 拖拽过程中直接改 DOM 宽度，避免每帧 setState 触发列表+编辑器整体重渲染
  const leftPanelRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const [isDragging, setIsDragging] = useState(false);
  /** 拖拽起点 X：只在 mousedown 写一次 */
  const dragStartXRef = useRef(0);
  /** 拖拽起始宽度：只在 mousedown 写一次，作为整个拖拽过程的计算基准 */
  const dragStartWidthRef = useRef(0);
  /** 拖拽过程中的实时宽度：每帧更新，松手时提交给 state */
  const currentWidthRef = useRef(leftWidth);

  // 左侧列表面板折叠状态，持久化到本地，刷新后保持
  const [leftCollapsed, setLeftCollapsed] = useState(
    () => localStorage.getItem('note_sidebar_collapsed') === '1',
  );

  /**
   * 切换左侧列表面板折叠状态并持久化。
   * @param collapsed 是否折叠
   */
  const toggleLeftCollapsed = useCallback((collapsed: boolean) => {
    setLeftCollapsed(collapsed);
    localStorage.setItem('note_sidebar_collapsed', collapsed ? '1' : '0');
  }, []);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const activeFolderId =
    selectedCategory.type === 'folder' ? selectedCategory.folderId : undefined;

  // 分类页签变化时同步到 localStorage（folder 视图依赖具体文件夹，不持久化）
  useEffect(() => {
    if (selectedCategory.type !== 'folder') setStoredCategoryType(selectedCategory.type);
  }, [selectedCategory.type, setStoredCategoryType]);

  /**
   * 从本地离线缓存构造列表数据。
   * 断网时列表页不能白屏，必须能读到上次联网时缓存的笔记与文件夹。
   * @returns 列表数据；本地无任何缓存时返回 null
   */
  const buildOfflineList = useCallback(async () => {
    const snapshot = await readList();
    const cached = await readAllNotes();
    if (!snapshot && cached.length === 0) return null;

    let items = cached.map(toNote);

    // 回收站内容不做离线缓存，离线时视为空
    if (selectedCategory.type === 'trash') items = [];

    if (filterType !== 'all') items = items.filter(n => n.noteType === filterType);
    if (activeFolderId) items = items.filter(n => n.folderId === activeFolderId);
    if (selectedCategory.type === 'pinned') items = items.filter(n => n.isPinned);
    if (selectedCategory.type === 'favorites') items = items.filter(n => n.isFavorite);
    if (selectedTagIds.length > 0) {
      items = items.filter(n => n.tags?.some(t => selectedTagIds.includes(t.id)));
    }
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase();
      items = items.filter(n =>
        `${n.title} ${n.previewText ?? ''} ${n.description ?? ''}`.toLowerCase().includes(q),
      );
    }
    items.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));

    return {
      notes: items,
      total: items.length,
      folders: snapshot?.folders ?? [],
      tags: snapshot?.tags ?? [],
    };
  }, [selectedCategory.type, filterType, activeFolderId, selectedTagIds, debouncedSearch]);

  // Fetch notes & folders
  const fetchNotes = useCallback(async () => {
    setLoading(true);
    try {
      const listParams: Parameters<typeof noteApi.list>[0] = {
        search: debouncedSearch || undefined,
        noteType: filterType !== 'all' ? filterType : undefined,
        folderId: activeFolderId,
        tagIds: selectedTagIds.length > 0 ? selectedTagIds : undefined,
        isPinned: selectedCategory.type === 'pinned' ? true : undefined,
        isFavorite: selectedCategory.type === 'favorites' ? true : undefined,
        limit: selectedCategory.type === 'recent' ? 30 : 500,
      };

      const fetchList = selectedCategory.type === 'trash'
        ? noteApi.listTrash({ search: debouncedSearch || undefined, limit: 500 })
        : noteApi.list(listParams);

      const [notesRes, foldersData, tagsData] = await Promise.all([
        fetchList,
        noteFolderApi.list(),
        noteTagApi.list(),
      ]);
      setNotes(notesRes.items);
      setNotesTotal(notesRes.total);
      setFolders(foldersData);
      setAllTags(tagsData);
      // 旁路写入离线缓存：失败静默，绝不影响在线流程
      if (userId) void cacheList(notesRes.items, foldersData, tagsData, userId);
    } catch (err) {
      // 网络不可达时回退到本地缓存，避免整页空白
      const fallback = await buildOfflineList();
      if (fallback) {
        setNotes(fallback.notes);
        setNotesTotal(fallback.total);
        setFolders(fallback.folders);
        setAllTags(fallback.tags);
      } else if (isNetworkError(err)) {
        toast.error('当前处于离线状态，本地暂无可用缓存');
      } else {
        toast.error('加载笔记失败');
      }
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, filterType, selectedTagIds, activeFolderId, selectedCategory.type, userId, buildOfflineList]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  // 空闲时预加载常用编辑器 chunk，减少首次打开延迟；
  // 慢速网络（2g/3g/saveData）跳过，避免抢占文件树接口带宽
  useEffect(() => {
    const isSlowNetwork = () => {
      const nav = navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      };
      if (nav.connection?.saveData) return true;
      const et = nav.connection?.effectiveType;
      return et === '2g' || et === '3g' || et === 'slow-2g';
    };
    if (isSlowNetwork()) return;
    const prefetch = () => {
      void import('../components/note/NoteRichTextEditor');
      void import('../components/note/NoteMarkdownEditor');
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(prefetch, { timeout: 3000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = setTimeout(prefetch, 800);
    return () => clearTimeout(timer);
  }, []);

  // Refresh list when AI sidebar or other consumers bump the global token
  useEffect(() => {
    if (notesRefreshToken === 0) return;
    fetchNotes();
  }, [notesRefreshToken, fetchNotes]);

  // Sync selected note after global refresh
  useEffect(() => {
    if (!selectedNote || notesRefreshToken === 0) return;
    const updated = notes.find(n => n.id === selectedNote.id);
    if (updated) setSelectedNote(updated);
  }, [notes, notesRefreshToken, selectedNote?.id]);

  /** 索引中：轮询列表，索引完成/失败后把状态同步到当前编辑器 */
  useEffect(() => {
    if (selectedNote?.indexStatus !== 'pending') return;
    const timer = window.setInterval(() => { fetchNotes(); }, 5000);
    return () => window.clearInterval(timer);
  }, [selectedNote?.indexStatus, fetchNotes]);

  useEffect(() => {
    if (!routeNoteId) return;
    const fresh = notes.find(n => n.id === routeNoteId);
    if (fresh && selectedNote && fresh.indexStatus !== selectedNote.indexStatus) {
      setSelectedNote(fresh);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, routeNoteId]);

  // Ctrl+N / Cmd+Shift+F shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        setShowNewNotePopover(v => !v);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p' && !e.shiftKey) {
        // 拦截浏览器原生的「打印」快捷键，改为打开快速切换器
        e.preventDefault();
        setShowQuickSwitcher(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        // 统一入口：笔记搜索 + 全局操作（编辑器命令用 ⌘⇧K 或本面板内的入口）
        // 捕获阶段拦下并阻止继续传播：Markdown 编辑器自身也把 Ctrl+K 绑定为插入图片
        e.preventDefault();
        e.stopPropagation();
        setShowCommandPalette(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        e.stopPropagation();
        setShowQuickCapture(true);
      }
      if (e.key === 'Escape') setShowNewNotePopover(false);
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, []);

  // Provide page context to AI sidebar
  useEffect(() => {
    const categoryLabel =
      selectedCategory.type === 'all' ? '全部笔记'
      : selectedCategory.type === 'recent' ? '最近'
      : selectedCategory.type === 'pinned' ? '置顶'
      : selectedCategory.type === 'favorites' ? '收藏'
      : selectedCategory.type === 'trash' ? '回收站'
      : folders.find(f => f.id === selectedCategory.folderId)?.name ?? '文件夹';

    const contextHint = selectedNote
      ? `当前分类: ${categoryLabel}。当前打开的笔记: 「${selectedNote.title}」(ID: ${selectedNote.id}, 类型: ${selectedNote.noteType})`
      : `当前分类: ${categoryLabel}。当前未选中任何笔记`;

    setPageAIContext({
      pageName: 'notes',
      moduleName: 'note',
      // 思维导图/流程图笔记默认推荐对应的专用设计助手
      recommendedAssistant: selectedNote?.noteType === 'mindmap'
        ? '思维导图设计助手'
        : selectedNote?.noteType === 'flowchart'
          ? '流程图设计助手'
          : '笔记助手',
      noteType: selectedNote?.noteType,
      contextHint,
      quickActions: selectedNote
        ? buildNoteQuickActions(selectedNote.noteType, selectedNote.title)
        : buildNoteQuickActions(undefined, ''),
      selectedEntities: selectedNote
        ? [{ type: 'note', id: selectedNote.id, name: selectedNote.title }]
        : undefined,
    });
    return () => setPageAIContext(null);
  }, [setPageAIContext, selectedNote, selectedCategory, folders]);

  /**
   * 把一个字段修改排队到离线队列，联网后自动回传服务端。
   * @param noteId 笔记 ID
   * @param payload 修改载荷
   * @returns 是否成功入队；本地无该笔记缓存时返回 false
   */
  const queueOfflineEdit = useCallback(async (noteId: string, payload: OutboxPayload) => {
    const cached = await readNote(noteId);
    if (!cached) return false;
    await saveOfflineEdit({ note: cached, payload });
    return true;
  }, []);

  /**
   * 统一处理「离线且该操作无法排队回传」的场景。
   * 这类操作（收藏、分享、版本、文件夹变更）没有幂等保证，离线时只提示不执行。
   * @param err 捕获到的异常
   * @returns 是否已按离线场景处理（调用方据此提前返回）
   */
  const notifyIfOffline = useCallback((err: unknown) => {
    if (isNetworkError(err)) {
      toast.error('当前处于离线状态，该操作需联网后使用');
      return true;
    }
    return false;
  }, []);

  /**
   * 解析新建笔记的落位文件夹，优先级自高到低：
   * 1. 当前选中笔记所在的文件夹 —— 新笔记与选中文件同级；
   * 2. 当前选中的文件夹视图；
   * 3. 以上都不满足则落到根目录（folderId 留空）。
   *
   * 回收站里的笔记处于已删除状态，不作为落位依据，直接按后两级处理。
   * 选中笔记的文件夹可能已被删除或离线缓存过期，需确认它仍然存在再使用。
   */
  const resolveCreateFolderId = useCallback((): string | undefined => {
    if (selectedCategory.type !== 'trash') {
      const noteFolderId = selectedNote?.folderId;
      if (noteFolderId && folders.some(f => f.id === noteFolderId)) return noteFolderId;
    }
    if (selectedCategory.type === 'folder') return selectedCategory.folderId;
    return undefined;
  }, [selectedCategory, selectedNote, folders]);

  const handleCreateNote = useCallback(async (noteType: string, folderId?: string) => {
    const targetFolderId = folderId || resolveCreateFolderId();
    try {
      const data: NoteCreate = {
        title: '无标题笔记',
        noteType: noteType as NoteCreate['noteType'],
        folderId: targetFolderId,
      };
      const newNote = await noteApi.create(data);
      setNotes(prev => [newNote, ...prev]);
      setNotesTotal(t => t + 1);
      setSelectedNote(newNote);
      toast.success('笔记已创建');
      if (userId) void cacheNoteMetas([newNote], userId);
    } catch (err) {
      // 离线新建：先落本地，联网后由队列自动回传服务端
      if (isNetworkError(err) && userId) {
        const local = await createOfflineNote({
          userId,
          title: '无标题笔记',
          noteType: noteType as Note['noteType'],
          folderId: targetFolderId,
        });
        const note = toNote(local);
        setNotes(prev => [note, ...prev]);
        setNotesTotal(t => t + 1);
        setSelectedNote(note);
        toast.success('已离线创建，联网后将自动同步');
        return;
      }
      toast.error('创建失败');
    }
  }, [resolveCreateFolderId, userId]);

  const documentInputRef = useRef<HTMLInputElement | null>(null);
  const dragCounterRef = useRef(0);
  const [docDragOver, setDocDragOver] = useState(false);
  const MAX_DOCUMENT_BYTES = 25 * 1024 * 1024;
  const DOCUMENT_ACCEPT = '.pdf,.docx,.xlsx,.pptx,.html,.htm,.doc,.xls,.ppt';

  const handleImportDocument = useCallback(() => {
    const input = documentInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  }, []);

  const importDocuments = useCallback(async (files: File[]) => {
    const candidates = files
      .filter(file => /\.(pdf|docx?|xlsx?|pptx?|html?)$/i.test(file.name))
      .slice(0, 5);
    if (candidates.length === 0) {
      toast.error('请选择 PDF / Word / Excel / PPT / HTML 文件');
      return;
    }
    let imported = 0;
    for (const file of candidates) {
      if (file.size > MAX_DOCUMENT_BYTES) {
        toast.error(`${file.name} 超过 25MB，已跳过`);
        continue;
      }
      try {
        const newNote = await noteDocumentApi.upload(file, {
          folderId: resolveCreateFolderId(),
        });
        setNotes(prev => [newNote, ...prev]);
        setNotesTotal(total => total + 1);
        setSelectedNote(newNote);
        if (userId) void cacheNoteMetas([newNote], userId);
        imported += 1;
      } catch (err) {
        toast.error(`${file.name}: ${err instanceof Error ? err.message : '导入失败'}`);
      }
    }
    if (imported > 0) toast.success(`已导入 ${imported} 个文档`);
  }, [resolveCreateFolderId, userId]);

  const handleDocumentDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    dragCounterRef.current = 0;
    setDocDragOver(false);
    const files = Array.from(event.dataTransfer.files || []);
    if (files.length > 0) void importDocuments(files);
  }, [importDocuments]);

  const handleDocumentDragEnter = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
    event.preventDefault();
    dragCounterRef.current += 1;
    setDocDragOver(true);
  }, []);

  const handleDocumentDragLeave = useCallback((event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types || []).includes('Files')) return;
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setDocDragOver(false);
  }, []);

  // Create note from template
  const handleCreateFromTemplate = useCallback(async (templateId: string) => {
    try {
      const newNote = await noteTemplateApi.createNoteFrom(templateId, {
        folderId: resolveCreateFolderId(),
      });
      setNotes(prev => [newNote, ...prev]);
      setNotesTotal(t => t + 1);
      setSelectedNote(newNote);
      toast.success('笔记已从模板创建');
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('从模板创建失败');
    }
  }, [resolveCreateFolderId, notifyIfOffline]);

  // Delete note
  const deleteNoteNow = useCallback(async (id: string) => {
    const isTrash = selectedCategory.type === 'trash';
    try {
      if (isTrash) {
        await noteApi.permanentDelete(id);
        toast.success('笔记已永久删除');
      } else {
        await noteApi.delete(id);
        toast.success('笔记已移入回收站');
      }
      void dropCached([id]);
      if (selectedNote?.id === id) handleCloseNote();
      fetchNotes();
    } catch (err) {
      // 离线删除：本地立即移除，服务端删除排队等待回传
      if (isNetworkError(err) && !isTrash) {
        const cached = await readNote(id);
        if (cached) {
          await deleteOfflineNote(cached);
          if (selectedNote?.id === id) handleCloseNote();
          setNotes(prev => prev.filter(n => n.id !== id));
          setNotesTotal(t => Math.max(0, t - 1));
          toast.success('已离线删除，联网后将自动同步');
          return;
        }
      }
      toast.error('删除失败');
    }
  }, [selectedNote, fetchNotes, selectedCategory.type, handleCloseNote]);

  const handleDeleteNote = useCallback((id: string) => {
    const isTrash = selectedCategory.type === 'trash';
    setConfirmState({
      title: isTrash ? '永久删除笔记' : '删除笔记',
      message: isTrash
        ? '确定永久删除这条笔记吗？此操作无法恢复。'
        : '删除后笔记会移入回收站，可随时恢复。',
      confirmLabel: isTrash ? '永久删除' : '移入回收站',
      variant: isTrash ? 'danger' : 'warning',
      action: () => deleteNoteNow(id),
    });
  }, [selectedCategory.type, deleteNoteNow]);

  const handleRestoreNote = useCallback(async (id: string) => {
    try {
      const restored = await noteApi.restore(id);
      toast.success('笔记已恢复');
      fetchNotes();
      setSelectedNote(restored);
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('恢复失败');
    }
  }, [fetchNotes, notifyIfOffline]);

  const handlePermanentDeleteNote = useCallback(async (id: string) => {
    if (!confirm('确定永久删除这条笔记吗？此操作无法恢复。')) return;
    try {
      await noteApi.permanentDelete(id);
      toast.success('笔记已永久删除');
      if (selectedNote?.id === id) handleCloseNote();
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('删除失败');
    }
  }, [selectedNote, fetchNotes, notifyIfOffline, handleCloseNote]);

  const handleToggleFavorite = useCallback(async (id: string, favorited: boolean) => {
    try {
      if (favorited) {
        await noteApi.removeFavorite(id);
        toast.success('已取消收藏');
      } else {
        await noteApi.addFavorite(id);
        toast.success('已收藏');
      }
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('操作失败');
    }
  }, [fetchNotes, notifyIfOffline]);

  const handleDuplicateNote = useCallback(async (id: string) => {
    try {
      const copied = await noteApi.duplicate(id);
      toast.success('笔记已复制');
      fetchNotes();
      setSelectedNote(copied);
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('复制失败');
    }
  }, [fetchNotes, notifyIfOffline]);

  const handlePinNote = useCallback(async (id: string, pinned: boolean) => {
    try {
      await noteApi.update(id, { isPinned: pinned } as NoteUpdate);
      toast.success(pinned ? '笔记已置顶' : '已取消置顶');
      fetchNotes();
    } catch (err) {
      // 置顶属于字段修改，可安全排队到联网后回传
      if (isNetworkError(err) && (await queueOfflineEdit(id, { isPinned: pinned }))) {
        toast.success(pinned ? '已置顶，联网后同步' : '已取消置顶，联网后同步');
        return;
      }
      toast.error('操作失败');
    }
  }, [fetchNotes, queueOfflineEdit]);

  // Move note to folder
  const handleMoveNote = useCallback(async (noteId: string, folderId: string | null) => {
    try {
      await noteApi.update(noteId, { folderId: folderId ?? undefined });
      toast.success('笔记已移动');
      fetchNotes();
    } catch (err) {
      if (isNetworkError(err) && (await queueOfflineEdit(noteId, { folderId: folderId ?? undefined }))) {
        toast.success('已移动，联网后同步');
        return;
      }
      toast.error('移动失败');
    }
  }, [fetchNotes, queueOfflineEdit]);

  // Folder CRUD
  const handleCreateFolder = useCallback(async (name: string, parentId?: string) => {
    try {
      await noteFolderApi.create({ name, parentId });
      toast.success('文件夹已创建');
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('创建文件夹失败');
    }
  }, [fetchNotes, notifyIfOffline]);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    try {
      await noteFolderApi.update(id, { name });
      toast.success('文件夹已重命名');
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('重命名失败');
    }
  }, [fetchNotes, notifyIfOffline]);

  const deleteFolderNow = useCallback(async (id: string) => {
    try {
      await noteFolderApi.delete(id);
      toast.success('文件夹已删除');
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('删除文件夹失败');
    }
  }, [fetchNotes, notifyIfOffline]);

  const handleDeleteFolder = useCallback((id: string) => {
    setConfirmState({
      title: '删除文件夹',
      message: '确定删除该文件夹吗？其中的笔记将移至根目录。',
      confirmLabel: '删除文件夹',
      variant: 'warning',
      action: () => deleteFolderNow(id),
    });
  }, [deleteFolderNow]);

  // Note updated from editor panel
  const handleNoteUpdated = useCallback((updated: Note) => {
    setNotes(prev => prev.map(n => n.id === updated.id ? updated : n));
    setSelectedNote(updated);
  }, []);

  const handleEditorTagsChanged = useCallback(() => {
    bumpNotesRefresh();
  }, [bumpNotesRefresh]);

  // Persist last opened note & restore on load
  const handleSelectNote = useCallback((note: Note) => {
    setSelectedNote(note);
    localStorage.setItem('note_last_opened_id', note.id);
  }, []);

  const handleQuickCaptureSave = useCallback(async (text: string) => {
    const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? '';
    const title = (firstLine || '随手记').slice(0, 60);
    const folderId = resolveCreateFolderId();
    try {
      const note = await noteApi.create({
        title,
        noteType: 'markdown',
        content: { text },
        folderId,
      });
      setNotes(prev => [note, ...prev]);
      setNotesTotal(total => total + 1);
      setSelectedNote(note);
      toast.success('已捕获到笔记');
    } catch (err) {
      if (isNetworkError(err) && userId) {
        const local = await createOfflineNote({ userId, title, noteType: 'markdown', folderId });
        await saveOfflineEdit({
          note: local,
          payload: { title, content: { text } } as OutboxPayload,
        });
        const note = toNote(local);
        setNotes(prev => [note, ...prev]);
        setNotesTotal(total => total + 1);
        setSelectedNote(note);
        toast.success('已离线捕获，联网后同步');
        return;
      }
      toast.error('捕获失败');
    }
  }, [resolveCreateFolderId, userId]);

  /* ────── 加密文档 / 加密文件夹 ────── */

  /** 打开笔记级加解密对话框；解锁时需带上真实保护域（可能来自文件夹） */
  const handleNoteLockAction = useCallback((
    action: 'encrypt' | 'unlock' | 'decrypt' | 'changePassword',
    noteId: string,
  ) => {
    const note = notes.find(n => n.id === noteId);
    const tokenScope: LockScope = action === 'unlock'
      ? ((note?.lockedScope ?? 'note') as LockScope)
      : 'note';
    const tokenId = action === 'unlock' ? (note?.lockedId ?? noteId) : noteId;
    const titleMap: Record<typeof action, string> = {
      encrypt: '加密文档',
      unlock: '解锁文档',
      decrypt: '取消文档加密',
      changePassword: '修改文档密码',
    };
    setLockDialog({ kind: 'note', action, targetId: noteId, tokenScope, tokenId, title: titleMap[action] });
  }, [notes]);

  /** 打开文件夹级加解密对话框 */
  const handleFolderLockAction = useCallback((
    action: 'encrypt' | 'unlock' | 'decrypt',
    folderId: string,
  ) => {
    const titleMap: Record<typeof action, string> = {
      encrypt: '加密文件夹',
      unlock: '解锁文件夹',
      decrypt: '取消文件夹加密',
    };
    setLockDialog({
      kind: 'folder', action, targetId: folderId,
      tokenScope: 'folder', tokenId: folderId, title: titleMap[action],
    });
  }, []);

  /**
   * 清除某文件夹（含全部子文件夹）内已缓存笔记的正文。
   * 文件夹加密后本地若仍留有这些笔记的明文，会形成绕过密码读取的漏洞。
   * @param rootId 根文件夹 ID
   */
  const stripFolderPlaintext = useCallback(async (rootId: string) => {
    const ids = new Set<string>([rootId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const f of folders) {
        if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
          ids.add(f.id);
          changed = true;
        }
      }
    }
    const cached = await readAllNotes();
    await stripCachedContent(cached.filter(n => n.folderId && ids.has(n.folderId)).map(n => n.id));
  }, [folders]);

  /**
   * 提交密码对话框：按上下文调用对应接口并落地解锁票据。
   * 抛出的异常交给 PasswordDialog 展示，保持对话框不关闭。
   */
  const handleLockSubmit = useCallback(async (password: string, newPassword?: string) => {
    if (!lockDialog) return;
    const { kind, action, targetId, tokenScope, tokenId } = lockDialog;
    let updatedNote: Note | null = null;

    if (kind === 'note') {
      if (action === 'encrypt') {
        const res = await noteLockApi.encrypt(targetId, password);
        setUnlockToken('note', targetId, res.unlockToken ?? null);
        updatedNote = res.note;
        toast.success('文档已加密');
      } else if (action === 'unlock') {
        const res = await noteLockApi.unlock(targetId, password);
        setUnlockToken(tokenScope, tokenId, res.unlockToken ?? null);
        updatedNote = res.note;
        toast.success('已解锁');
      } else if (action === 'decrypt') {
        const res = await noteLockApi.decrypt(targetId, password);
        clearUnlockToken('note', targetId);
        updatedNote = res.note;
        toast.success('已取消加密');
      } else {
        const res = await noteLockApi.changePassword(targetId, password, newPassword ?? '');
        setUnlockToken('note', targetId, res.unlockToken ?? null);
        updatedNote = res.note;
        toast.success('密码已修改');
      }
    } else if (action === 'encrypt') {
      const res = await noteFolderApi.encrypt(targetId, password);
      setUnlockToken('folder', targetId, res.unlockToken ?? null);
      toast.success(res.affected > 0 ? `文件夹已加密（${res.affected} 篇文档）` : '文件夹已加密');
    } else if (action === 'unlock') {
      const res = await noteFolderApi.unlock(targetId, password);
      setUnlockToken('folder', targetId, res.unlockToken ?? null);
      toast.success('文件夹已解锁');
    } else {
      const res = await noteFolderApi.decrypt(targetId, password);
      clearUnlockToken('folder', targetId);
      toast.success(res.affected > 0 ? `已取消加密（${res.affected} 篇文档）` : '已取消加密');
    }

    fetchNotes();
    if (updatedNote && selectedNote?.id === updatedNote.id) handleNoteUpdated(updatedNote);

    // 加密成功后清除本地缓存的明文副本
    if (action === 'encrypt') {
      if (kind === 'note') void stripCachedContent([targetId]);
      else void stripFolderPlaintext(targetId);
    }
  }, [lockDialog, fetchNotes, selectedNote, handleNoteUpdated, stripFolderPlaintext]);

  /**
   * 快速切换器选中笔记：目标可能不在当前筛选结果里（如在回收站视图切到一篇正常笔记），
   * 因此先重置为「全部笔记」，再打开，保证目标在列表中可见。
   */
  const handleQuickSwitch = useCallback((note: Note) => {
    setSelectedCategory({ type: 'all' });
    setFilterType('all');
    setSelectedTagIds([]);
    setSearchQuery('');
    handleSelectNote(note);
  }, [handleSelectNote, setFilterType, setSelectedTagIds, setSearchQuery]);

  useEffect(() => {
    // 移动端默认停留在列表页，不自动跳进上次打开的笔记
    if (isMobile) return;
    // 深链（/note/:id）优先，不能再用"上次打开"覆盖它
    if (routeNoteId) return;
    if (notes.length === 0) return;
    const lastId = localStorage.getItem('note_last_opened_id');
    if (lastId && !selectedNote) {
      const found = notes.find(n => n.id === lastId);
      if (found) setSelectedNote(found);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes, routeNoteId]);

  // Resize drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    isDraggingRef.current = true;
    dragStartXRef.current = e.clientX;
    // 以「当前真实 DOM 宽度」而非 state 作为基准：拖拽中途 DOM 已被直接改写，
    // state 还是旧值，若用它做基准会导致第一次移动就跳一段。
    const domWidth = leftPanelRef.current?.getBoundingClientRect().width;
    const base = domWidth && domWidth > 0 ? domWidth : leftWidth;
    dragStartWidthRef.current = base;
    currentWidthRef.current = base;
  }, [leftWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      // 基准只在 mousedown 时记录一次；这里始终以它为原点做增量计算，
      // 不能把上一帧的结果再累加回去，否则拖拽会「越拖越跑」。
      const diff = e.clientX - dragStartXRef.current;
      const newWidth = Math.min(MAX_LEFT_WIDTH, Math.max(MIN_LEFT_WIDTH, dragStartWidthRef.current + diff));
      // 拖拽中只改 DOM 宽度：避免每个 mousemove 都触发 React 重渲染，
      // 那会让列表（已虚拟化）与编辑器一起重建，得不偿失。
      if (leftPanelRef.current) leftPanelRef.current.style.width = `${newWidth}px`;
      currentWidthRef.current = newWidth;
    };
    const handleMouseUp = () => {
      const finalWidth = currentWidthRef.current;
      setIsDragging(false);
      isDraggingRef.current = false;
      // 松手时才提交到 state 并持久化
      setLeftWidth(finalWidth);
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, setLeftWidth]);

  // 非拖拽状态下把 state 宽度同步到 DOM（折叠/展开、持久化回填都走这里）。
  // 拖拽中必须跳过，否则每次重渲染都会把刚拖出来的宽度又覆盖回旧值。
  useEffect(() => {
    if (isDraggingRef.current) return;
    if (leftPanelRef.current) leftPanelRef.current.style.width = `${leftWidth}px`;
  }, [leftWidth]);

  const combinedRefreshTrigger = editorRefreshTrigger + notesRefreshToken;

  /** 切到移动端时退出全屏：移动端不显示全屏按钮，否则会无法退出 */
  useEffect(() => {
    if (isMobile && isFullscreen) setIsFullscreen(false);
  }, [isMobile, isFullscreen]);

  /** 左侧笔记列表面板：移动端与桌面端共用；折叠 / 全屏为桌面专属能力，移动端不传 */
  const noteListPanelEl = (
    <NoteListPanel
      notes={notes}
      folders={folders}
      allTags={allTags}
      notesTotal={notesTotal}
      selectedNoteId={selectedNote?.id || null}
      onSelectNote={handleSelectNote}
      onCreateNote={handleCreateNote}
      onImportDocument={handleImportDocument}
      onDeleteNote={handleDeleteNote}
      onRestoreNote={handleRestoreNote}
      onPermanentDeleteNote={handlePermanentDeleteNote}
      onDuplicateNote={handleDuplicateNote}
      onPinNote={handlePinNote}
      onToggleFavorite={handleToggleFavorite}
      onMoveNote={handleMoveNote}
      onCreateFolder={handleCreateFolder}
      onRenameFolder={handleRenameFolder}
      onDeleteFolder={handleDeleteFolder}
      onNoteLockAction={handleNoteLockAction}
      onFolderLockAction={handleFolderLockAction}
      searchQuery={searchQuery}
      onSearchChange={setSearchQuery}
      filterType={filterType}
      onFilterTypeChange={setFilterType}
      selectedTagIds={selectedTagIds}
      onSelectedTagIdsChange={setSelectedTagIds}
      onOpenTemplateGallery={() => setShowTemplateGallery(true)}
      selectedCategory={selectedCategory}
      onCategoryChange={setSelectedCategory}
      searchInputRef={searchInputRef}
      loading={loading}
      isDark={isDark}
      onRefresh={fetchNotes}
      isMobile={isMobile}
      isFullscreen={isFullscreen}
      onToggleFullscreen={isMobile ? undefined : () => setIsFullscreen(f => !f)}
      onToggleCollapse={isMobile ? undefined : () => toggleLeftCollapsed(true)}
      userId={userId}
    />
  );

  /** 编辑器面板：移动端传入 onBack 以支持返回列表，桌面端不显示返回按钮 */
  const editorPanelEl = selectedNote ? (
    <NoteEditorPanel
      note={selectedNote}
      folders={folders}
      allTags={allTags}
      onNoteUpdated={handleNoteUpdated}
      onTagsChanged={handleEditorTagsChanged}
      onDuplicateNote={handleDuplicateNote}
      onDeleteNote={handleDeleteNote}
      onMoveNote={handleMoveNote}
      onToggleFullscreen={() => setIsFullscreen(f => !f)}
      isFullscreen={isFullscreen}
      isDark={isDark}
      refreshTrigger={combinedRefreshTrigger}
      onBack={isMobile ? handleCloseNote : undefined}
      onOpenRelated={(id) => {
        const target = notes.find(n => n.id === id);
        if (target) handleSelectNote(target);
        else navigate(`/note/${id}`);
      }}
      onImportDocument={handleImportDocument}
      highlightChunkId={citationChunkId}
      onDismissCitation={() => {
        if (routeNoteId) navigate(`/note/${routeNoteId}`, { replace: true });
      }}
    />
  ) : (
    <div className={`h-full flex flex-col items-center justify-center ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500/10 to-amber-500/10 flex items-center justify-center mb-4">
        <FileText size={28} className={isDark ? 'text-gray-600' : 'text-gray-300'} />
      </div>
      <h3 className={`text-lg font-medium mb-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        选择一个笔记开始编辑
      </h3>
      <p className={`text-sm mb-6 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
        或创建一个新笔记
      </p>
      <div className="grid grid-cols-2 gap-3">
        {[
          { type: 'markdown', label: 'Markdown', icon: <Code2 size={20} />, color: 'from-green-500 to-emerald-600' },
          { type: 'mindmap', label: '思维导图', icon: <Brain size={20} />, color: 'from-orange-500 to-red-500' },
          { type: 'rich_text', label: '富文本', icon: <FileText size={20} />, color: 'from-orange-500 to-orange-600' },
          { type: 'flowchart', label: 'Drawio', icon: <GitFork size={20} />, color: 'from-orange-500 to-amber-600' },
        ].map(item => (
          <button
            key={item.type}
            onClick={() => handleCreateNote(item.type)}
            className={`flex flex-col items-center gap-2 px-6 py-4 rounded-xl border transition-all hover:scale-105 hover:shadow-md ${
              isDark
                ? 'border-gray-700 bg-gray-800/50 hover:border-gray-600 text-gray-200'
                : 'border-gray-200 bg-white hover:border-gray-300 text-gray-700'
            }`}
          >
            <div className={`w-10 h-10 rounded-lg bg-gradient-to-br ${item.color} flex items-center justify-center text-white`}>
              {item.icon}
            </div>
            <span className="text-sm font-medium">{item.label}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={handleImportDocument}
        className={`mt-4 inline-flex items-center gap-2 rounded-xl border px-4 py-2 text-xs transition-colors ${
          isDark
            ? 'border-gray-700 bg-gray-800/50 text-gray-300 hover:border-gray-600'
            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
        }`}
      >
        <Upload size={14} />
        导入文档（PDF / Word / Excel / PPT / HTML）
      </button>
    </div>
  );

  /** 文档拖拽只绑定在笔记列表区域，避免抢占编辑器内的图片拖放 */
  const listDropProps = {
    onDragEnter: handleDocumentDragEnter,
    onDragOver: (event: React.DragEvent) => {
      if (Array.from(event.dataTransfer.types || []).includes('Files')) event.preventDefault();
    },
    onDragLeave: handleDocumentDragLeave,
    onDrop: handleDocumentDrop,
  };

  return (
    <div
      className={`h-full flex overflow-hidden ${isMobile ? 'pb-14' : ''} ${isFullscreen ? 'fixed inset-0 z-50' : ''} ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}
    >
      {docDragOver && (
        <div className="pointer-events-none fixed inset-0 z-[9998] flex flex-col items-center justify-center gap-3 border-4 border-dashed border-orange-500 bg-orange-500/10">
          <Upload size={44} className="text-orange-600" />
          <div className="rounded-lg bg-white px-4 py-2 text-sm font-medium text-orange-600 shadow-lg dark:bg-gray-800">
            松开以导入文档（PDF / Word / Excel / PPT / HTML）
          </div>
        </div>
      )}
      {isMobile ? (
        /* 移动端：单列前进 / 返回。未选中显示列表，选中显示全屏编辑器（顶部带返回按钮） */
        <div className="flex-1 min-w-0 h-full min-h-0">
          {selectedNote ? (
            editorPanelEl
          ) : (
            <div className="h-full min-h-0" {...listDropProps}>{noteListPanelEl}</div>
          )}
        </div>
      ) : leftCollapsed ? (
        /* 桌面端 · 折叠态：收成窄条，仅保留展开按钮 */
        <div className={`w-9 shrink-0 flex flex-col items-center pt-3 border-r ${isDark ? 'border-gray-700 bg-[#15232a]' : 'border-gray-200 bg-white'}`}>
          <button
            onClick={() => toggleLeftCollapsed(false)}
            className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
            title="展开侧栏"
          >
            <PanelLeftOpen size={16} />
          </button>
        </div>
      ) : (
        /* 桌面端 · 展开态：笔记列表 + 可拖拽分隔条 */
        <>
          <div
            ref={leftPanelRef}
            className={`shrink-0 border-r ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
            style={{ width: leftWidth }}
          >
            <div className="h-full min-h-0" {...listDropProps}>{noteListPanelEl}</div>
          </div>

          {/* Resize handle */}
          <div
            onMouseDown={handleMouseDown}
            className={`w-1 cursor-col-resize hover:bg-orange-500/50 transition-colors shrink-0 ${isDragging ? 'bg-orange-500/50' : ''}`}
          />
        </>
      )}

      {/* 桌面端 · 右侧编辑器面板（移动端已在上方单列渲染） */}
      {!isMobile && (
        <div className="flex-1 min-w-0 h-full min-h-0">
          {editorPanelEl}
        </div>
      )}

      {/* ⌘P 快速切换笔记：定位用，与 ⌘K 命令面板分工 */}
      <NoteQuickSwitcher
        open={showQuickSwitcher}
        onClose={() => setShowQuickSwitcher(false)}
        notes={notes}
        selectedNoteId={selectedNote?.id ?? null}
        onSelect={handleQuickSwitch}
        isDark={isDark}
      />

      {/* ⌘K 统一面板：笔记检索（服务端高亮）+ 全局操作 */}
      <GlobalCommandPalette
        open={showCommandPalette}
        onClose={() => setShowCommandPalette(false)}
        notes={notes}
        selectedNoteId={selectedNote?.id ?? null}
        onSelectNote={handleQuickSwitch}
        isDark={isDark}
        actions={[
          { id: 'note.new.rich', label: '新建富文本笔记', hint: '⌘N', keywords: 'new note', run: () => { void handleCreateNote('rich_text'); } },
          { id: 'note.capture', label: '快速捕获…', hint: '⌘⇧N', keywords: 'capture inbox 速记 随手记', run: () => setShowQuickCapture(true) },
          { id: 'note.new.markdown', label: '新建 Markdown 笔记', keywords: 'new md', run: () => { void handleCreateNote('markdown'); } },
          { id: 'note.new.mindmap', label: '新建思维导图', keywords: 'mindmap', run: () => { void handleCreateNote('mindmap'); } },
          { id: 'note.new.flowchart', label: '新建流程图', keywords: 'drawio flowchart', run: () => { void handleCreateNote('flowchart'); } },
          { id: 'daily.today', label: '今日笔记', keywords: 'daily journal 日记 今日', run: () => { void noteApi.dailyToday().then(note => setSelectedNote(note)).catch(() => toast.error('打开今日笔记失败')); } },
          { id: 'daily.review', label: '生成今日回顾', keywords: 'review daily 回顾 AI', run: () => { void noteApi.dailyReview().then(async review => { const created = await noteApi.create({ title: `回顾 ${review.date}`, noteType: 'markdown', content: { text: review.markdown } }); setSelectedNote(created); toast.success('回顾已生成'); }).catch(() => toast.error('生成回顾失败')); } },
          { id: 'note.template', label: '从模板新建', keywords: 'template 模板', run: () => setShowTemplateGallery(true) },
          { id: 'editor.commands', label: '打开编辑器命令…', hint: '⌘⇧K', keywords: 'palette 命令', run: () => window.dispatchEvent(new Event('aidrivenote:open-command-palette')) },
          { id: 'ai.open', label: '打开 AI 助手', hint: '⌘J', keywords: 'ai chat 助手', run: () => openAI() },
          { id: 'nav.sync', label: '本地同步 / 知识库设置', keywords: 'sync kb 知识库', run: () => navigate('/settings/sync') },
          { id: 'nav.settings', label: '打开设置', keywords: 'settings', run: () => navigate('/settings/models') },
        ]}
      />

      <QuickCaptureDialog
        open={showQuickCapture}
        isDark={isDark}
        onClose={() => setShowQuickCapture(false)}
        onSave={handleQuickCaptureSave}
      />

      {/* 移动端底部导航：列表 / 搜索 / 新建 / AI */}
      {isMobile && (
        <nav className={`fixed inset-x-0 bottom-0 z-40 flex h-14 items-center justify-around border-t text-[11px] backdrop-blur ${
          isDark ? 'border-gray-700 bg-gray-900/95 text-gray-300' : 'border-gray-200 bg-white/95 text-gray-600'
        }`}>
          <button type="button" onClick={handleCloseNote} className="flex flex-1 flex-col items-center gap-0.5 py-1">
            <FileText size={17} />
            列表
          </button>
          <button type="button" onClick={() => searchInputRef.current?.focus()} className="flex flex-1 flex-col items-center gap-0.5 py-1">
            <Code2 size={17} />
            搜索
          </button>
          <button type="button" onClick={() => setShowNewNotePopover(true)} className="flex flex-1 flex-col items-center gap-0.5 py-1 text-orange-600">
            <Plus size={18} />
            新建
          </button>
          <button type="button" onClick={() => openAI()} className="flex flex-1 flex-col items-center gap-0.5 py-1">
            <Brain size={17} />
            AI
          </button>
        </nav>
      )}

      {/* 移动端快速捕获入口 */}
      {isMobile && !selectedNote && (
        <button
          type="button"
          onClick={() => setShowQuickCapture(true)}
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-orange-600 text-white shadow-lg active:scale-95"
          title="快速捕获 (⌘⇧N)"
        >
          <Plus size={22} />
        </button>
      )}

      <ConfirmDialog
        isOpen={confirmState !== null}
        onClose={() => setConfirmState(null)}
        onConfirm={() => {
          const pending = confirmState;
          setConfirmState(null);
          if (pending) void pending.action();
        }}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel ?? '确定'}
        cancelLabel="取消"
        variant={confirmState?.variant ?? 'warning'}
      />

      {/* Ctrl+N new note popover */}
      <input
        ref={documentInputRef}
        type="file"
        accept={DOCUMENT_ACCEPT}
        multiple
        className="hidden"
        onChange={event => {
          const files = Array.from(event.target.files || []);
          if (files.length > 0) void importDocuments(files);
        }}
      />
      {showNewNotePopover && (
        <div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => setShowNewNotePopover(false)}>
          <div
            className={`rounded-2xl shadow-2xl border p-5 w-72 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
            onClick={e => e.stopPropagation()}
          >
            <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
              新建笔记 <span className={`text-xs font-normal ml-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>⌘N</span>
            </h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                { type: 'markdown', label: 'Markdown', icon: <Code2 size={18} />, color: 'from-green-500 to-emerald-600' },
                { type: 'rich_text', label: '富文本', icon: <FileText size={18} />, color: 'from-orange-500 to-orange-600' },
                { type: 'mindmap', label: '思维导图', icon: <Brain size={18} />, color: 'from-orange-500 to-red-500' },
                { type: 'flowchart', label: 'Drawio', icon: <GitFork size={18} />, color: 'from-orange-500 to-amber-600' },
              ].map(item => (
                <button
                  key={item.type}
                  onClick={() => { handleCreateNote(item.type); setShowNewNotePopover(false); }}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all hover:scale-105 ${
                    isDark ? 'border-gray-700 bg-gray-700/50 hover:bg-gray-700 text-gray-200' : 'border-gray-100 bg-gray-50 hover:bg-gray-100 text-gray-700'
                  }`}
                >
                  <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${item.color} flex items-center justify-center text-white shrink-0`}>
                    {item.icon}
                  </div>
                  <span className="text-xs font-medium">{item.label}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => { setShowNewNotePopover(false); handleImportDocument(); }}
              className={`mt-2 flex w-full items-center justify-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                isDark ? 'border-gray-700 text-gray-300 hover:bg-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              <FileType size={14} />
              导入文档…
            </button>
          </div>
        </div>
      )}

      {/* Template Gallery */}
      <NoteTemplateGallery
        visible={showTemplateGallery}
        onClose={() => setShowTemplateGallery(false)}
        onSelectTemplate={handleCreateFromTemplate}
        isDark={isDark}
      />

      {/* 加密文档 / 加密文件夹密码对话框 */}
      <PasswordDialog
        open={Boolean(lockDialog)}
        mode={(({
          encrypt: 'set',
          unlock: 'unlock',
          decrypt: 'decrypt',
          changePassword: 'change',
        }) as Record<LockDialogState['action'], PasswordDialogMode>)[lockDialog?.action ?? 'unlock']}
        title={lockDialog?.title ?? ''}
        description={
          lockDialog?.kind === 'folder' && lockDialog.action === 'encrypt'
            ? '文件夹内所有文档将使用该密码加密，打开时需输入密码'
            : lockDialog?.kind === 'folder' && lockDialog.action === 'decrypt'
              ? '将解除文件夹内所有文档的加密，恢复为明文存储'
              : undefined
        }
        isDark={isDark}
        onClose={() => setLockDialog(null)}
        onSubmit={handleLockSubmit}
      />
    </div>
  );
};

export default NotesPage;
