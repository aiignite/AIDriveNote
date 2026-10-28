/**
 * NoteListPanel – 笔记列表面板（参照 AIIgniteNote 风格）
 *
 * 特性：文件夹树 + 简洁笔记列表 + 右键菜单 + 搜索筛选
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  Search, Plus, FileText, Code2, Brain, GitFork, FileType,
  MoreHorizontal, Trash2, ArrowUpDown, Folder, FolderOpen,
  FolderPlus, ChevronRight, ChevronDown, Pencil, FolderInput, Copy, Pin, PinOff,
  BookTemplate, RotateCcw, Star, RefreshCw, Maximize2, Minimize2, FolderSync, Clock,
  PanelLeftClose, Tag, X, Check, LayoutGrid, CheckSquare, Square,
  Lock, Unlock, KeyRound, LockOpen, Database,
} from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  isStringArray,
  usePersistentState,
} from '../../hooks/usePersistentState';
import { ensurePermission, isSupported as isSyncSupported, loadHandleFromIndexedDB } from '../../services/sync/folderAccess';
import { runSync } from '../../services/sync/syncEngine';
import { SYNC_CONFIG_EVENT, loadSyncConfig } from '../../services/sync/kbConfig';
import { getUnlockToken, NOTE_TYPES, EDITABLE_NOTE_TYPES, type Note, type NoteFolder, type NoteTag } from '../../services/note';

/* ── helpers ────────────────────────────────────── */

const TYPE_ICON: Record<string, { icon: React.ReactNode; color: string; bgColor: string }> = {
  rich_text: {
    icon: <FileText size={14} />,
    color: 'text-orange-500 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-900/20',
  },
  markdown: {
    icon: <Code2 size={14} />,
    color: 'text-green-600 dark:text-green-400',
    bgColor: 'bg-green-50 dark:bg-green-900/20',
  },
  mindmap: {
    icon: <Brain size={14} />,
    color: 'text-purple-600 dark:text-purple-400',
    bgColor: 'bg-purple-50 dark:bg-purple-900/20',
  },
  flowchart: {
    icon: <GitFork size={14} />,
    color: 'text-orange-600 dark:text-orange-400',
    bgColor: 'bg-orange-50 dark:bg-orange-900/20',
  },
  document: {
    icon: <FileType size={14} />,
    color: 'text-blue-600 dark:text-blue-400',
    bgColor: 'bg-blue-50 dark:bg-blue-900/20',
  },
};

/** 笔记类型的中文名，用于筛选按钮的 title / aria-label（图标本身不显示文字） */
const TYPE_LABEL: Record<string, string> = {
  rich_text: '富文本',
  markdown: 'Markdown',
  mindmap: '思维导图',
  flowchart: '流程图',
  document: '文档',
};

// 相对时间格式化
function formatRelativeTime(dateStr?: string | null): string {
  if (!dateStr) return '';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  if (isNaN(then)) return '';
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}小时前`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay === 1) return '昨天';
  if (diffDay < 30) return `${diffDay}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
}

type SortMode = 'updatedAt' | 'createdAt' | 'title';

export type NoteCategory =
  | { type: 'all' }
  | { type: 'recent' }
  | { type: 'pinned' }
  | { type: 'favorites' }
  | { type: 'trash' }
  | { type: 'folder'; folderId: string };


/**
 * 分类页签：文字标签改为图标按钮。
 *
 * 侧栏宽度有限（默认 320px，可拖到 240px），五个文字页签换行会占掉两行高度，
 * 把垂直空间让给笔记列表。图标含义对老用户是自明的，故不保留文字标签；
 * 完整名称保留在 title / aria-label 中，悬停与读屏仍可获知。
 */
const CATEGORY_TABS: {
  key: Exclude<NoteCategory['type'], 'folder'>;
  label: string;
  icon: React.ReactNode;
}[] = [
  { key: 'all', label: '全部笔记', icon: <LayoutGrid size={14} /> },
  { key: 'recent', label: '最近', icon: <Clock size={14} /> },
  { key: 'pinned', label: '置顶', icon: <Pin size={14} /> },
  { key: 'favorites', label: '收藏', icon: <Star size={14} /> },
  { key: 'trash', label: '回收站', icon: <Trash2 size={14} /> },
];

/* ── Folder tree node type ──────────────────────── */

interface TreeNode {
  type: 'folder' | 'note';
  id: string;
  folder?: NoteFolder;
  note?: Note;
  children: TreeNode[];
  level: number;
}

/* ── props ──────────────────────────────────────── */

/** 虚拟滚动的一行：文件夹行、新建输入行或笔记行 */
type FlatRow =
  | { kind: 'folder'; key: string; node: TreeNode }
  | { kind: 'newFolder'; key: string; level: number }
  | { kind: 'note'; key: string; note: Note; level: number };

export interface NoteListPanelProps {
  notes: Note[];
  folders: NoteFolder[];
  allTags?: NoteTag[];
  notesTotal?: number;
  selectedNoteId: string | null;
  onSelectNote: (note: Note) => void;
  onCreateNote: (noteType: string, folderId?: string) => void;
  /** 打开文档导入（选择文件后由页面创建文档笔记） */
  onImportDocument?: () => void;
  onDeleteNote: (id: string) => void;
  onRestoreNote?: (id: string) => void;
  onPermanentDeleteNote?: (id: string) => void;
  onDuplicateNote?: (id: string) => void;
  onPinNote?: (id: string, pinned: boolean) => void;
  onToggleFavorite?: (id: string, favorited: boolean) => void;
  onMoveNote: (noteId: string, folderId: string | null) => void;
  onCreateFolder: (name: string, parentId?: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  filterType?: string;
  onFilterTypeChange?: (type: string) => void;
  selectedTagIds?: string[];
  onSelectedTagIdsChange?: (ids: string[]) => void;
  filterProjectId?: string;
  onFilterProjectIdChange?: (id: string) => void;
  projects?: { id: string; name: string }[];
  onOpenTemplateGallery?: () => void;
  selectedCategory?: NoteCategory;
  onCategoryChange?: (category: NoteCategory) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  loading?: boolean;
  isDark?: boolean;
  onRefresh?: () => void;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** 折叠左侧列表面板 */
  onToggleCollapse?: () => void;
  /** 移动端窄屏布局：常显操作入口、隐藏桌面专属控件 */
  isMobile?: boolean;
  /** 打开「发送到邮箱」弹窗 */
  /** 当前登录用户 ID：本地同步写入 manifest 时需要用于账号绑定校验 */
  userId?: string | null;
  /** 笔记加密相关操作：encrypt / unlock / decrypt / changePassword */
  onNoteLockAction?: (action: 'encrypt' | 'unlock' | 'decrypt' | 'changePassword', noteId: string) => void;
  /** 文件夹加密相关操作：encrypt / unlock / decrypt */
  onFolderLockAction?: (action: 'encrypt' | 'unlock' | 'decrypt', folderId: string) => void;
}

const NoteListPanel: React.FC<NoteListPanelProps> = ({
  notes,
  folders,
  allTags = [],
  notesTotal,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
  onImportDocument,
  onDeleteNote,
  onRestoreNote,
  onPermanentDeleteNote,
  onDuplicateNote,
  onPinNote,
  onToggleFavorite,
  onMoveNote,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  searchQuery,
  onSearchChange,
  filterType: filterTypeProp,
  onFilterTypeChange,
  selectedTagIds: selectedTagIdsProp,
  onSelectedTagIdsChange,
  filterProjectId = '',
  onFilterProjectIdChange,
  projects = [],
  onOpenTemplateGallery,
  selectedCategory: selectedCategoryProp,
  onCategoryChange,
  searchInputRef,
  loading = false,
  isDark = false,
  onRefresh,
  isFullscreen = false,
  onToggleFullscreen,
  onToggleCollapse,
  isMobile = false,
  userId,
  onNoteLockAction,
  onFolderLockAction,
}) => {
  const [internalCategory, setInternalCategory] = useState<NoteCategory>({ type: 'all' });
  const selectedCategory = selectedCategoryProp ?? internalCategory;
  const isTrashView = selectedCategory.type === 'trash';
  const setSelectedCategory = useCallback((cat: NoteCategory) => {
    if (!selectedCategoryProp) setInternalCategory(cat);
    onCategoryChange?.(cat);
  }, [selectedCategoryProp, onCategoryChange]);
  // 排序方式持久化：刷新后保持用户习惯的排序视角
  const [sortMode, setSortMode] = usePersistentState<SortMode>('note_sort_mode', 'updatedAt');
  const [sortOrder, setSortOrder] = usePersistentState<'asc' | 'desc'>('note_sort_order', 'desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [showTagMenu, setShowTagMenu] = useState(false);
  const [internalFilterType, setInternalFilterType] = useState<string>('all');
  const filterType = filterTypeProp ?? internalFilterType;
  const setFilterType = useCallback((type: string) => {
    if (filterTypeProp === undefined) setInternalFilterType(type);
    onFilterTypeChange?.(type);
  }, [filterTypeProp, onFilterTypeChange]);
  const [internalSelectedTagIds, setInternalSelectedTagIds] = useState<string[]>([]);
  const selectedTagIds = selectedTagIdsProp ?? internalSelectedTagIds;

  /* ── 多选状态（批量整理）──
   * 仅在非回收站视图启用：回收站的批量语义（永久删除）与常规批量操作差异较大，
   * 先保持单选，避免误触导致不可逆操作。 */
  const [checkedIds, setCheckedIds] = useState<string[]>([]);
  /** 移动端滑动起点：左滑收藏、右滑置顶 */
  const swipeStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  /** 滑动后抑制紧随其后的 click，避免误打开笔记 */
  const suppressRowClickRef = useRef(false);
  /** Shift 连选的锚点，取最后一次点击的笔记下标 */
  const selectionAnchorRef = useRef<number | null>(null);
  /** 移动端没有 hover，checkbox 需常显 */
  const showCheckboxes = !isTrashView;
  /** 批量操作条中的「移动到文件夹」下拉开关 */
  const [showBatchMenu, setShowBatchMenu] = useState(false);
  const batchMenuRef = useRef<HTMLDivElement>(null);

  /* ── 拖拽移动 ──────────────────────────────────
   * 拖笔记到文件夹即可移动，比右键菜单少两次点击。
   * 用原生 HTML5 DnD：无需额外依赖，且移动端无鼠标时自动失效，不影响触屏体验。 */
  const [draggingNoteId, setDraggingNoteId] = useState<string | null>(null);
  /** 当前悬停的目标文件夹；null 表示不在任何文件夹上 */
  const [dropFolderId, setDropFolderId] = useState<string | null>(null);

  /** 开始拖拽：记录笔记 ID 到 dataTransfer，便于 drop 时读取 */
  const handleNoteDragStart = useCallback((e: React.DragEvent, noteId: string) => {
    setDraggingNoteId(noteId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', noteId);
  }, []);

  /** 结束/取消拖拽：清理高亮状态 */
  const handleDragEnd = useCallback(() => {
    setDraggingNoteId(null);
    setDropFolderId(null);
  }, []);

  /**
   * 放下：把笔记移动到目标文件夹。
   * @param e 拖拽事件
   * @param folderId 目标文件夹 ID；null 表示移回根目录
   */
  const handleDrop = useCallback((e: React.DragEvent, folderId: string | null) => {
    e.preventDefault();
    e.stopPropagation();
    const noteId = e.dataTransfer.getData('text/plain') || draggingNoteId;
    handleDragEnd();
    if (!noteId) return;
    onMoveNote(noteId, folderId);
    toast.success(`已移动「${notes.find(n => n.id === noteId)?.title || '笔记'}」`);
  }, [draggingNoteId, onMoveNote, handleDragEnd, notes]);

  /** 批量移动的文件夹选项（带缩进层级，空 id 表示根目录已单独处理） */
  const folderOptions = useMemo(() => {
    const byId = new Map(folders.map(f => [f.id, f]));
    const depthOf = (folder: NoteFolder): number => {
      let depth = 0;
      let cur = folder.parentId;
      const seen = new Set<string>([folder.id]);
      while (cur && byId.has(cur) && !seen.has(cur)) {
        seen.add(cur);
        depth += 1;
        cur = byId.get(cur)!.parentId;
      }
      return depth;
    };
    return folders.map(f => ({ id: f.id, name: f.name, depth: depthOf(f) }));
  }, [folders]);

  // 点击外部关闭批量移动菜单
  useEffect(() => {
    if (!showBatchMenu) return;
    const onDown = (e: MouseEvent) => {
      if (batchMenuRef.current && !batchMenuRef.current.contains(e.target as Node)) {
        setShowBatchMenu(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [showBatchMenu]);

  /** 清空多选 */
  const clearChecked = useCallback(() => {
    setCheckedIds([]);
    selectionAnchorRef.current = null;
  }, []);
  const toggleTagFilter = useCallback((tagId: string) => {
    const next = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter(id => id !== tagId)
      : [...selectedTagIds, tagId];
    if (selectedTagIdsProp === undefined) setInternalSelectedTagIds(next);
    onSelectedTagIdsChange?.(next);
  }, [selectedTagIds, selectedTagIdsProp, onSelectedTagIdsChange]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  /** 本地同步进行中 */
  const [syncingLocal, setSyncingLocal] = useState(false);
  /** 本地同步进度（用于按钮上的加载态提示） */
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number; phase: string } | null>(null);
  /** 知识库根文件夹 ID（知识库同步源的作用域，用于树上打标） */
  const [kbRootId, setKbRootId] = useState<string | null>(null);
  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'note' | 'folder'; id: string;
  } | null>(null);
  // Inline rename state
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Move-to-folder modal
  const [movingNoteId, setMovingNoteId] = useState<string | null>(null);

  /** 读取知识库根标记，并跟随设置页的配置变更即时刷新 */
  useEffect(() => {
    const syncKbRoot = () => {
      const cfg = loadSyncConfig();
      setKbRootId(cfg.kb.rootFolderId);
    };
    syncKbRoot();
    window.addEventListener(SYNC_CONFIG_EVENT, syncKbRoot);
    return () => window.removeEventListener(SYNC_CONFIG_EVENT, syncKbRoot);
  }, []);
  // New folder inline input
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState('');

  const sortMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const tagMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  /**
   * 受加密保护的文件夹 ID 集合（含「祖先已加密 → 子孙同样受保护」的传播）。
   * 用于列表锁图标与右键菜单：判断某文件夹内笔记是否处于加密保护中。
   */
  const encryptedFolderIds = useMemo(() => {
    const byId = new Map(folders.map(f => [f.id, f]));
    const cache = new Map<string, boolean>();
    const isProtected = (id: string): boolean => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      const folder = byId.get(id);
      if (!folder) return false;
      const result = !!folder.isEncrypted || (folder.parentId ? isProtected(folder.parentId) : false);
      cache.set(id, result);
      return result;
    };
    const set = new Set<string>();
    folders.forEach(f => { if (isProtected(f.id)) set.add(f.id); });
    return set;
  }, [folders]);

  // Close popups on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) setShowSortMenu(false);
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setShowAddMenu(false);
      if (tagMenuRef.current && !tagMenuRef.current.contains(e.target as Node)) setShowTagMenu(false);
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) setContextMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Focus rename input
  useEffect(() => {
    if (renamingFolderId && renameInputRef.current) renameInputRef.current.focus();
  }, [renamingFolderId]);

  // Auto-expand ancestor folders when selectedNoteId changes
  useEffect(() => {
    if (!selectedNoteId) return;
    const note = notes.find(n => n.id === selectedNoteId);
    if (!note?.folderId) return;
    // Build ancestor chain
    const ancestors: string[] = [];
    let current = folders.find(f => f.id === note.folderId);
    while (current) {
      ancestors.push(current.id);
      current = current.parentId ? folders.find(f => f.id === current!.parentId) : undefined;
    }
    if (ancestors.length > 0) {
      setExpandedFolders(prev => {
        const next = new Set(prev);
        ancestors.forEach(id => next.add(id));
        return next;
      });
    }
  }, [selectedNoteId, notes, folders]);

  // Focus new folder input
  useEffect(() => {
    if (newFolderParent !== undefined && newFolderInputRef.current) newFolderInputRef.current.focus();
  }, [newFolderParent]);

  // Sort notes (type/folder/pinned/recent filtering handled server-side)
  const sortedNotes = useMemo(() => {
    const list = [...notes];

    if (selectedCategory.type === 'recent') {
      return list;
    }

    const dir = sortOrder === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      if (sortMode === 'title') return dir * (a.title || '').localeCompare(b.title || '');
      const aTime = new Date(sortMode === 'updatedAt' ? (a.updatedAt || '') : (a.createdAt || '')).getTime();
      const bTime = new Date(sortMode === 'updatedAt' ? (b.updatedAt || '') : (b.createdAt || '')).getTime();
      return dir * (aTime - bTime);
    });
    return list;
  }, [notes, sortMode, sortOrder, selectedCategory.type]);

  /** 切换单条笔记的选中状态；shift 连选时按区间批量勾选 */
  const toggleNoteChecked = useCallback((noteId: string, index: number, shiftKey: boolean) => {
    setCheckedIds(prev => {
      const isChecked = prev.includes(noteId);
      if (shiftKey && selectionAnchorRef.current !== null && showCheckboxes) {
        const [start, end] = [selectionAnchorRef.current, index].sort((a, b) => a - b);
        const span = sortedNotes.slice(start, end + 1).map(n => n.id);
        return isChecked ? prev.filter(id => !span.includes(id)) : [...new Set([...prev, ...span])];
      }
      selectionAnchorRef.current = index;
      return isChecked ? prev.filter(id => id !== noteId) : [...prev, noteId];
    });
  }, [sortedNotes, showCheckboxes]);

  /** 全选当前筛选结果；已全选时再次点击取消 */
  const toggleCheckAll = useCallback(() => {
    setCheckedIds(prev => (prev.length === sortedNotes.length ? [] : sortedNotes.map(n => n.id)));
  }, [sortedNotes]);

  // 切换分类 / 搜索 / 筛选后，已勾选的笔记可能不在当前视图，清空避免误操作
  useEffect(() => {
    clearChecked();
  }, [selectedCategory.type, filterType, selectedTagIds.join(','), searchQuery, clearChecked]);

  /** 点击笔记行：多选态下改为切换勾选，否则正常打开 */
  const handleRowClick = useCallback((note: Note, index: number, shiftKey: boolean) => {
    if (checkedIds.length > 0 || showCheckboxes && (shiftKey)) {
      toggleNoteChecked(note.id, index, shiftKey);
      return;
    }
    onSelectNote(note);
  }, [checkedIds.length, showCheckboxes, toggleNoteChecked, onSelectNote]);

  /* ── 批量操作 ────────────────────────────────── */

  /** 批量删除：逐条调用既有删除逻辑，保持与单条删除一致的软删语义 */
  const handleBatchDelete = useCallback(() => {
    const ids = [...checkedIds];
    if (!ids.length) return;
    const msg = `确定删除选中的 ${ids.length} 篇笔记吗？\n删除后可在回收站恢复。`;
    if (!window.confirm(msg)) return;
    ids.forEach(id => onDeleteNote(id));
    clearChecked();
    toast.success(`已删除 ${ids.length} 篇笔记`);
  }, [checkedIds, onDeleteNote, clearChecked]);

  /** 批量移动到指定文件夹 */
  const handleBatchMove = useCallback((folderId: string | null) => {
    const ids = [...checkedIds];
    if (!ids.length) return;
    ids.forEach(id => onMoveNote(id, folderId));
    clearChecked();
    toast.success(`已移动 ${ids.length} 篇笔记`);
  }, [checkedIds, onMoveNote, clearChecked]);

  /** 批量置顶 / 取消置顶 */
  const handleBatchPin = useCallback((pinned: boolean) => {
    if (!onPinNote) return;
    const ids = [...checkedIds];
    if (!ids.length) return;
    ids.forEach(id => onPinNote(id, pinned));
    clearChecked();
    toast.success(pinned ? `已置顶 ${ids.length} 篇笔记` : `已取消置顶 ${ids.length} 篇笔记`);
  }, [checkedIds, onPinNote, clearChecked]);

  /** 批量收藏 / 取消收藏 */
  const handleBatchFavorite = useCallback((favorited: boolean) => {
    if (!onToggleFavorite) return;
    const ids = [...checkedIds];
    if (!ids.length) return;
    ids.forEach(id => onToggleFavorite(id, favorited));
    clearChecked();
    toast.success(favorited ? `已收藏 ${ids.length} 篇笔记` : `已取消收藏 ${ids.length} 篇笔记`);
  }, [checkedIds, onToggleFavorite, clearChecked]);

  // Build tree structure (only for "all" category, not trash)
  const tree = useMemo((): TreeNode[] => {
    if (selectedCategory.type !== 'all' || isTrashView) return [];

    const folderMap = new Map<string, TreeNode>();
    const rootNodes: TreeNode[] = [];

    // Create folder nodes
    for (const f of folders) {
      folderMap.set(f.id, { type: 'folder', id: f.id, folder: f, children: [], level: 0 });
    }
    // Build hierarchy
    for (const f of folders) {
      const node = folderMap.get(f.id)!;
      if (f.parentId && folderMap.has(f.parentId)) {
        const parent = folderMap.get(f.parentId)!;
        node.level = parent.level + 1;
        parent.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    // Add notes to their folders or root
    for (const n of sortedNotes) {
      const noteNode: TreeNode = { type: 'note', id: n.id, note: n, children: [], level: 0 };
      if (n.folderId && folderMap.has(n.folderId)) {
        const parent = folderMap.get(n.folderId)!;
        noteNode.level = parent.level + 1;
        parent.children.push(noteNode);
      } else {
        rootNodes.push(noteNode);
      }
    }
    return rootNodes;
  }, [folders, sortedNotes, selectedCategory.type]);

  const displayCount = notesTotal ?? sortedNotes.length;

  // 递归计算文件夹下的笔记数量（含子文件夹）。
  // 对同一棵树会被每个文件夹行调用一次，故按节点 id 缓存结果，
  // 避免每次渲染都把整棵树重复遍历 N 遍。
  const noteCountCacheRef = useRef(new Map<string, number>());

  const countNotesInNode = useCallback((node: TreeNode): number => {
    if (node.type !== 'folder' || !node.folder) return 0;
    const cached = noteCountCacheRef.current.get(node.folder.id);
    if (cached !== undefined) return cached;

    let count = 0;
    for (const child of node.children) {
      if (child.type === 'note') count++;
      else count += countNotesInNode(child);
    }
    noteCountCacheRef.current.set(node.folder.id, count);
    return count;
  }, []);

  // 树变化时清空缓存（笔记移动、改名等都会影响计数）
  useEffect(() => {
    noteCountCacheRef.current.clear();
  }, [tree]);

  const toggleFolder = useCallback((id: string) => {
    setExpandedFolders(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, type: 'note' | 'folder', id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, type, id });
  }, []);

  /**
   * 顶部「+」新建：不再自行推导目标文件夹，交给上层按
   * 「选中笔记所在文件夹 → 选中的文件夹视图 → 根目录」的优先级统一解析，
   * 避免这里与上层各算一套导致落位不一致。
   */
  const handleCreate = useCallback((type: string) => {
    onCreateNote(type);
    setShowAddMenu(false);
  }, [onCreateNote]);

  const startNewFolder = useCallback((parentId?: string) => {
    setNewFolderParent(parentId ?? null);
    setNewFolderName('');
    if (parentId) setExpandedFolders(prev => new Set(prev).add(parentId));
  }, []);

  const submitNewFolder = useCallback(() => {
    if (newFolderName.trim()) {
      onCreateFolder(newFolderName.trim(), newFolderParent ?? undefined);
    }
    setNewFolderParent(undefined);
    setNewFolderName('');
  }, [newFolderName, newFolderParent, onCreateFolder]);

  const submitRename = useCallback(() => {
    if (renamingFolderId && renameValue.trim()) {
      onRenameFolder(renamingFolderId, renameValue.trim());
    }
    setRenamingFolderId(null);
    setRenameValue('');
  }, [renamingFolderId, renameValue, onRenameFolder]);

  const sortLabels: Record<SortMode, string> = { updatedAt: '修改时间', createdAt: '创建时间', title: '标题' };

  /**
   * 顶部「本地同步」按钮：执行一次与本地文件夹的双向同步。
   *
   * 与「设置 → 本地同步」页共用同一个 runSync 引擎；这里做的是「一键同步」——
   * 已绑定目录就直接跑，未绑定则提示去设置页绑定，避免在这里弹出目录选择器
   * （浏览器要求必须由用户手势触发，而点击时已错过最佳时机）。
   */
  const handleLocalSync = useCallback(async () => {
    if (syncingLocal) return;
    if (!isSyncSupported()) {
      toast.error('当前浏览器不支持本地文件夹同步，请使用 Chrome / Edge 桌面版');
      return;
    }
    if (!userId) {
      toast.error('未获取到当前用户信息，请重新登录后再试');
      return;
    }

    // 按启用的同步源逐一执行；每个源使用自己的目录句柄与配置
    const cfg = loadSyncConfig();
    type Job = {
      key: 'notes' | 'kb';
      label: string;
      direction: 'two-way' | 'kb';
      excludeFolderIds?: string[];
      kb?: {
        rootFolderId: string;
        rootFolderName: string;
        ignore: string[];
        protect: string[];
      };
    };
    const jobs: Job[] = [];
    if (cfg.notes.enabled) {
      jobs.push({
        key: 'notes',
        label: '笔记同步',
        direction: 'two-way',
        excludeFolderIds: cfg.kb.rootFolderId ? [cfg.kb.rootFolderId] : [],
      });
    }
    if (cfg.kb.enabled && cfg.kb.rootFolderId) {
      jobs.push({
        key: 'kb',
        label: '知识库同步',
        direction: 'kb',
        kb: {
          rootFolderId: cfg.kb.rootFolderId,
          rootFolderName: cfg.kb.rootFolderName,
          ignore: cfg.kb.ignore,
          protect: cfg.kb.protect,
        },
      });
    }
    if (jobs.length === 0) {
      toast.error('尚未启用本地同步，请到「设置 → 本地同步」中开启');
      return;
    }

    setSyncingLocal(true);
    let changed = 0;
    let failures = 0;
    let ran = false;
    const skipped: string[] = [];
    try {
      for (const job of jobs) {
        const handle = await loadHandleFromIndexedDB(job.key);
        if (!handle) {
          skipped.push(`${job.label}（未绑定目录）`);
          continue;
        }
        if (!(await ensurePermission(handle, { requestInGesture: true }))) {
          skipped.push(`${job.label}（未授权）`);
          continue;
        }
        const report = await runSync(handle, {
          mode: 'apply',
          userId,
          direction: job.direction,
          kb: job.kb,
          excludeFolderIds: job.excludeFolderIds,
          onProgress: p => setSyncProgress({ done: p.done, total: p.total, phase: p.phase }),
        });
        ran = true;
        changed +=
          report.downloaded +
          report.uploaded +
          report.imported +
          report.localDeleted.length +
          report.remoteDeleted.length +
          report.createdFolders.length +
          report.uploadedFolders.length +
          report.removedFolders.length +
          report.conflicts.length;
        failures += report.errors.length;
      }

      if (skipped.length > 0) toast.error(`${skipped.join('、')}，已跳过`);
      if (ran) {
        if (changed === 0 && failures === 0) toast.success('已是最新，无改动');
        else if (changed > 0) toast.success(`同步完成：更新 ${changed} 项`);
        if (failures > 0) {
          toast.error(`其中 ${failures} 项失败，详见设置页同步结果`);
        }
        // 同步会改动笔记与文件夹，通知外层刷新列表
        onRefresh?.();
      }
    } catch (err) {
      console.error('Local sync failed:', err);
      toast.error(err instanceof Error ? err.message : '同步失败，请稍后重试');
    } finally {
      setSyncingLocal(false);
      setSyncProgress(null);
    }
  }, [syncingLocal, userId, onRefresh]);

  /* ── Render a single note item ─────────────────── */
  const renderNoteItem = (note: Note, level: number) => {
    const isSelected = note.id === selectedNoteId;
    const isChecked = checkedIds.includes(note.id);
    const noteIndex = sortedNotes.findIndex(n => n.id === note.id);
    const typeCfg = TYPE_ICON[note.noteType] || TYPE_ICON.rich_text;
    const paddingLeft = level * 16 + 12;
    // 摘要优先取正文预览，其次用描述兜底；压缩空白并截断，避免长文撑爆行高
    const preview = (note.previewText || note.description || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const tags = note.tags ?? [];

    return (
      <div
        key={note.id}
        role="option"
        aria-selected={isSelected}
        tabIndex={0}
        onKeyDown={e => {
          // 键盘可达：Enter 打开、Space 切换勾选
          if (e.key === 'Enter') {
            e.preventDefault();
            if (checkedIds.length === 0) onSelectNote(note);
          } else if (e.key === ' ') {
            e.preventDefault();
            toggleNoteChecked(note.id, noteIndex, e.shiftKey);
          }
        }}
        onTouchStart={e => {
          if (!isMobile) return;
          const touch = e.touches[0];
          swipeStartRef.current = { id: note.id, x: touch.clientX, y: touch.clientY };
          suppressRowClickRef.current = false;
        }}
        onTouchEnd={e => {
          if (!isMobile) return;
          const start = swipeStartRef.current;
          swipeStartRef.current = null;
          if (!start || start.id !== note.id) return;
          const touch = e.changedTouches[0];
          const dx = touch.clientX - start.x;
          const dy = touch.clientY - start.y;
          if (Math.abs(dx) < 56 || Math.abs(dy) > 40) return;
          suppressRowClickRef.current = true;
          if (dx < 0) {
            onToggleFavorite?.(note.id, !note.isFavorite);
            toast.success(note.isFavorite ? '已取消收藏' : '已收藏');
          } else {
            onPinNote?.(note.id, !note.isPinned);
            toast.success(note.isPinned ? '已取消置顶' : '已置顶');
          }
        }}
        onClick={e => {
          if (suppressRowClickRef.current) {
            suppressRowClickRef.current = false;
            return;
          }
          handleRowClick(note, noteIndex, e.shiftKey);
        }}
        onContextMenu={(e) => handleContextMenu(e, 'note', note.id)}
        draggable={!isMobile}
        onDragStart={e => handleNoteDragStart(e, note.id)}
        onDragEnd={handleDragEnd}
        className={`group flex items-center gap-2 px-3 py-2.5 md:py-2 cursor-pointer rounded-lg mx-1 transition-all ${
          draggingNoteId === note.id ? 'opacity-40' : ''
        } ${
          isChecked
            ? (isDark ? 'bg-orange-900/25' : 'bg-orange-50/70')
            : isSelected
              ? (isDark ? 'bg-orange-900/30' : 'bg-orange-50')
              : (isDark ? 'hover:bg-gray-800/50' : 'hover:bg-gray-50')
        }`}
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        {/* 多选勾选框：桌面端悬停显现，进入多选态后常驻 */}
        {showCheckboxes && (
          <span
            onClick={e => {
              e.stopPropagation();
              toggleNoteChecked(note.id, noteIndex, e.shiftKey);
            }}
            title={isChecked ? '取消选中' : '选中（Shift 连选）'}
            className={`shrink-0 cursor-pointer transition-opacity ${
              checkedIds.length > 0 || isMobile
                ? 'opacity-100'
                : 'opacity-0 group-hover:opacity-100'
            }`}
          >
            <span
              className={`flex items-center justify-center w-3.5 h-3.5 rounded border transition-colors ${
                isChecked
                  ? 'bg-orange-600 border-orange-600'
                  : (isDark ? 'border-gray-600 bg-gray-800' : 'border-gray-300 bg-white')
              }`}
            >
              {isChecked && <Check size={11} className="text-white" strokeWidth={3} />}
            </span>
          </span>
        )}
        {/* Type icon badge */}
        <div className={`shrink-0 p-1.5 rounded-md ${typeCfg.bgColor}`}>
          <span className={typeCfg.color}>{typeCfg.icon}</span>
        </div>
        {/* 两行布局：标题 / 元信息（标签，无标签时改用摘要）+ 时间。
            摘要不独占一行：列表项越矮一屏能看的条数越多，正文线索改由悬停 title 提供。 */}
        <div className="flex-1 min-w-0" title={preview || undefined}>
          <span className={`block text-sm truncate ${
            isSelected
              ? (isDark ? 'text-orange-300 font-medium' : 'text-orange-700 font-medium')
              : (isDark ? 'text-gray-200' : 'text-gray-700')
          }`}>
            {note.isPinned && <Pin size={10} className="inline mr-1 text-amber-500" />}
            {note.isFavorite && <Star size={10} className="inline mr-1 text-amber-400 fill-amber-400" />}
            {(note.isEncrypted || (!!note.folderId && encryptedFolderIds.has(note.folderId))) && (
              <Lock size={10} className="inline mr-1 text-orange-500" />
            )}
            {note.title || '无标题'}
          </span>
          {/* 不换行：标签保持原宽，摘要占据剩余空间并在溢出时省略 */}
          <div className="flex items-center gap-1 mt-0.5 min-w-0">
            {tags.length > 0 ? (
              <>
                {tags.slice(0, 2).map(tag => (
                  <span
                    key={tag.id}
                    className="shrink-0 text-[10px] px-1.5 py-0 rounded-full"
                    style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                  >
                    {tag.name}
                  </span>
                ))}
                {tags.length > 2 && (
                  <span className={`shrink-0 text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                    +{tags.length - 2}
                  </span>
                )}
              </>
            ) : preview ? (
              <span className={`min-w-0 flex-1 truncate text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {preview}
              </span>
            ) : null}
            <span className={`shrink-0 text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
              {formatRelativeTime(note.updatedAt)}
            </span>
          </div>
        </div>
        {/* Three-dot menu：触屏无 hover，移动端常显 */}
        <button
          onClick={e => { e.stopPropagation(); handleContextMenu(e, 'note', note.id); }}
          className={`p-1.5 md:p-0.5 rounded transition ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'} ${isDark ? 'hover:bg-gray-600 text-gray-400' : 'hover:bg-gray-200 text-gray-400'}`}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  /* ── Render a folder node ──────────────────────── */
  /**
   * 渲染单个文件夹行（虚拟滚动单位）。
   * 子节点不再在这里递归展开——拍平阶段（flatRows）已按展开状态输出全部可见行。
   */
  const renderFolderRow = (node: TreeNode) => {
    const folder = node.folder!;
    const isExpanded = expandedFolders.has(folder.id);
    const hasChildren = node.children.length > 0;
    const paddingLeft = node.level * 16 + 12;

    return (
      <div
          onClick={() => toggleFolder(folder.id)}
          onContextMenu={(e) => handleContextMenu(e, 'folder', folder.id)}
          onDragOver={e => {
            if (!draggingNoteId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setDropFolderId(folder.id);
          }}
          onDragLeave={() => setDropFolderId(cur => (cur === folder.id ? null : cur))}
          onDrop={e => handleDrop(e, folder.id)}
          className={`group flex items-center gap-2 px-3 py-1.5 mx-1 rounded-lg cursor-pointer transition-all ${
            dropFolderId === folder.id
              ? (isDark ? 'bg-orange-900/40 ring-1 ring-orange-500' : 'bg-orange-100 ring-1 ring-orange-400')
              : isDark ? 'hover:bg-gray-800/50' : 'hover:bg-gray-50'
          }`}
          style={{ paddingLeft: `${paddingLeft}px` }}
        >
          <span className={`shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {hasChildren
              ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />)
              : <span className="w-3.5" />
            }
          </span>
          {/* Folder icon */}
          <span className="text-amber-400">
            {isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />}
          </span>
          {/* Name or rename input */}
          {renamingFolderId === folder.id ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={submitRename}
              onKeyDown={e => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') { setRenamingFolderId(null); } }}
              className={`flex-1 text-sm px-1 py-0 border-b outline-none ${isDark ? 'bg-transparent border-gray-600 text-white' : 'bg-transparent border-gray-300 text-gray-800'}`}
              onClick={e => e.stopPropagation()}
            />
          ) : (
            <span className={`flex-1 text-sm font-medium truncate ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
              {encryptedFolderIds.has(folder.id) && (
                <Lock size={11} className="inline mr-1 -mt-0.5 text-orange-500" />
              )}
              {folder.name}
            </span>
          )}
          {/* 知识库根文件夹标记 */}
          {(folder.id === kbRootId || folder.isSystem) && renamingFolderId !== folder.id && (
            <span
              className="shrink-0 flex items-center"
              title="知识库根文件夹：系统保护，不可删除或移动"
            >
              <Database size={12} className="text-emerald-500" />
            </span>
          )}
          {/* Note count badge */}
          {!renamingFolderId && (() => {
            const cnt = countNotesInNode(node);
            return cnt > 0 ? (
              <span className={`text-xs px-1.5 rounded-full shrink-0 ${isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-100 text-gray-500'}`}>
                {cnt}
              </span>
            ) : null;
          })()}
          {/* Hover actions：移动端常显，避免触屏无法触发 */}
          <div className={`flex items-center gap-0.5 transition-opacity ${isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
            <button
              onClick={e => { e.stopPropagation(); startNewFolder(folder.id); }}
              className={`p-1.5 md:p-0.5 rounded ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-400 hover:text-gray-700'}`}
              title="新建子文件夹"
            >
              <FolderPlus size={13} />
            </button>
          </div>
        </div>
    );
  };

  /**
   * 新建文件夹输入框：作为独立行插在目标位置之前。
   * 虚拟滚动下行高固定，混在 renderFolderRow 里会破坏 measure 测高，故抽出。
   */
  const renderNewFolderRow = (parentId: string | null, level: number) => (
    <div className="flex items-center gap-2 px-4 py-1 mx-1" style={{ paddingLeft: `${level * 16 + 12}px` }}>
      <Folder size={14} className="text-amber-400 shrink-0" />
      <input
        ref={newFolderInputRef}
        value={newFolderName}
        onChange={e => setNewFolderName(e.target.value)}
        onBlur={submitNewFolder}
        onKeyDown={e => { if (e.key === 'Enter') submitNewFolder(); if (e.key === 'Escape') setNewFolderParent(undefined); }}
        placeholder="文件夹名称"
        className={`flex-1 text-sm px-1 py-0.5 border-b outline-none ${isDark ? 'bg-transparent border-gray-600 text-white placeholder-gray-500' : 'bg-transparent border-gray-300 text-gray-800 placeholder-gray-400'}`}
      />
    </div>
  );

  /* ── 空状态（按场景差异化，而非统一「暂无笔记」）── */
  const renderEmptyState = () => {
    const muted2 = isDark ? 'text-gray-400' : 'text-gray-500';
    const box = `flex flex-col items-center justify-center py-10 px-4 text-center ${muted2}`;

    // 回收站为空
    if (isTrashView) {
      return (
        <div className={box}>
          <Trash2 size={26} className="mb-2 opacity-40" />
          <p className="text-xs">回收站是空的</p>
          <p className="text-[11px] mt-1 opacity-70">删除的笔记会在这里保留，可随时恢复</p>
        </div>
      );
    }

    // 有筛选条件但无结果 —— 引导清除筛选
    const hasFilter = Boolean(searchQuery)
      || filterType !== 'all'
      || selectedTagIds.length > 0
      || selectedCategory.type !== 'all';
    if (hasFilter) {
      return (
        <div className={box}>
          <Search size={26} className="mb-2 opacity-40" />
          <p className="text-xs">没有匹配的笔记</p>
          <p className="text-[11px] mt-1 opacity-70">试试调整搜索词或筛选条件</p>
          <button
            type="button"
            onClick={() => {
              onSearchChange('');
              setFilterType('all');
              onSelectedTagIdsChange?.([]);
              setSelectedCategory({ type: 'all' });
            }}
            className={`mt-3 text-[11px] px-2.5 py-1 rounded border transition-colors ${
              isDark ? 'border-gray-700 text-gray-300 hover:bg-gray-800' : 'border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}
          >
            清除筛选条件
          </button>
        </div>
      );
    }

    // 全新用户 —— 引导新建
    return (
      <div className={box}>
        <FileText size={26} className="mb-2 opacity-40" />
        <p className="text-xs">还没有笔记</p>
        <p className="text-[11px] mt-1 opacity-70">新建第一篇，开始记录想法</p>
        <button
          type="button"
          onClick={() => onCreateNote('rich_text')}
          className="mt-3 text-[11px] px-2.5 py-1 rounded bg-orange-600 text-white hover:bg-orange-700 transition-colors"
        >
          新建笔记 {!isMobile && '⌘N'}
        </button>
      </div>
    );
  };

  /* ── 虚拟滚动 ──────────────────────────────────
   * 文件夹树与笔记混排在一个滚动容器里，直接虚拟化需要先把树拍平成一维行数组。
   * 行高不固定（文件夹行与笔记行不同、笔记行有两行文本），故用 measureElement 实测高度。 */
  const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | null>(null);

  /**
   * 把「文件夹树 + 笔记」拍平成一维行数组。
   * 「全部笔记」视图按树的展示顺序输出；其余分类（最近/置顶/收藏/回收站）
   * 是一维笔记列表，无需拍平。折叠的文件夹及其子行不进入结果。
   */
  const flatRows = useMemo<FlatRow[]>(() => {
    if (selectedCategory.type !== 'all' || isTrashView) {
      return sortedNotes.map(note => ({ kind: 'note' as const, key: note.id, note, level: 0 }));
    }
    const rows: FlatRow[] = [];
    const walk = (node: TreeNode) => {
      // 正在新建子文件夹：输入框作为该文件夹的下一行
      if (node.type === 'folder' && node.folder && newFolderParent === node.folder.id) {
        rows.push({ kind: 'newFolder', key: `nf:${node.folder.id}`, level: node.level + 1 });
      }
      if (node.type === 'folder' && node.folder) {
        rows.push({ kind: 'folder', key: `f:${node.folder.id}`, node });
        if (expandedFolders.has(node.folder.id)) {
          node.children.forEach(walk);
        }
        return;
      }
      if (node.type === 'note' && node.note) {
        rows.push({ kind: 'note', key: `n:${node.note.id}`, note: node.note, level: node.level });
      }
    };
    // 根目录新建输入框固定排在最前
    if (newFolderParent === null) rows.push({ kind: 'newFolder', key: 'nf:root', level: 0 });
    tree.forEach(walk);
    return rows;
  }, [tree, sortedNotes, selectedCategory.type, isTrashView, expandedFolders, newFolderParent]);

  /** 行高随内容（是否重命名中、是否两行标签）变化，需实测后回写 */
  const rowVirtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => scrollContainer,
    // 行高预估：文件夹行 34px；笔记行三行（标题/摘要/标签+时间）约 74px。
    // 预估值只影响首屏滚动条长度，measureElement 会在渲染后校正为真实高度。
    estimateSize: index => (flatRows[index]?.kind === 'folder' ? 34 : 74),
    overscan: 12,
    getItemKey: index => flatRows[index]?.key ?? index,
  });

  /** 把实测行高回写给虚拟器 */
  const measureRow = useCallback((el: Element | null) => {
    if (el) rowVirtualizer.measureElement(el);
  }, [rowVirtualizer]);

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  /* ── Move-to-folder modal ──────────────────────── */
  const renderMoveModal = () => {
    if (!movingNoteId) return null;
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={() => setMovingNoteId(null)}>
        <div
          className={`w-72 max-h-80 rounded-xl shadow-2xl border overflow-hidden ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
          onClick={e => e.stopPropagation()}
        >
          <div className={`px-[var(--app-gutter)] py-3 border-b text-sm font-medium ${isDark ? 'border-gray-700 text-gray-200' : 'border-gray-200 text-gray-800'}`}>
            移动到文件夹
          </div>
          <div className="overflow-y-auto max-h-60 py-1">
            <button
              onClick={() => { onMoveNote(movingNoteId, null); setMovingNoteId(null); }}
              className={`w-full flex items-center gap-2 px-4 py-2 text-sm ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
            >
              <FileText size={14} className="text-gray-400" /> 根目录（无文件夹）
            </button>
            {folders.map(f => (
              <button
                key={f.id}
                onClick={() => { onMoveNote(movingNoteId, f.id); setMovingNoteId(null); }}
                className={`w-full flex items-center gap-2 px-4 py-2 text-sm ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <Folder size={14} className="text-amber-400" /> {f.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-[#15232a]' : 'bg-white'}`}>
      {/* Header */}
      <div className={`flex items-center justify-between px-[var(--app-gutter)] py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center gap-1.5 min-w-0">
          {onToggleCollapse ? (
            <button
              onClick={() => onToggleCollapse()}
              className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
              title="折叠侧栏"
            >
              <PanelLeftClose size={15} />
            </button>
          ) : null}
          <h3 className={`text-sm font-semibold truncate ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
            {notes.length}
          </h3>
        </div>
        <div className="flex items-center gap-1">
          {!isTrashView ? (
            <button
              onClick={() => void handleLocalSync()}
              disabled={syncingLocal}
              className={`p-1.5 rounded-md transition-colors ${
                isDark
                  ? 'text-gray-400 hover:text-white hover:bg-gray-700'
                  : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'
              } ${syncingLocal ? 'opacity-50 cursor-not-allowed' : ''}`}
              title="同步已启用的本地同步源（知识库 / 笔记）"
            >
              <FolderSync size={15} className={syncingLocal ? 'animate-spin' : ''} />
            </button>
          ) : null}
          {onRefresh ? (
            <button
              onClick={() => onRefresh()}
              className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
              title="刷新"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          ) : null}
          {!isMobile && onToggleFullscreen ? (
            <button
              onClick={() => onToggleFullscreen()}
              className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
              title={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            </button>
          ) : null}
          {/* New folder */}
          <button
            onClick={() => startNewFolder()}
            className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
            title="新建文件夹"
          >
            <FolderPlus size={15} />
          </button>
          {/* Sort */}
          <div className="relative" ref={sortMenuRef}>
            <button
              onClick={() => setShowSortMenu(!showSortMenu)}
              className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
              title="排序"
            >
              <ArrowUpDown size={15} />
            </button>
            {showSortMenu && (
              <div className={`absolute right-0 top-full mt-1 w-40 rounded-lg shadow-lg border z-50 py-1 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
                {(Object.entries(sortLabels) as [SortMode, string][]).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => { setSortMode(key); setShowSortMenu(false); }}
                    className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${
                      sortMode === key
                        ? (isDark ? 'text-orange-400 bg-gray-700/50' : 'text-orange-600 bg-orange-50')
                        : (isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50')
                    }`}
                  >
                    {label}
                  </button>
                ))}
                <div className={`h-px my-1 ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`} />
                <button
                  onClick={() => { setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc'); setShowSortMenu(false); }}
                  className={`w-full text-left px-3 py-1.5 text-sm transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                >
                  {sortOrder === 'asc' ? '↑ 正序 → 倒序' : '↓ 倒序 → 正序'}
                </button>
              </div>
            )}
          </div>
          {/* Add note dropdown */}
          <div className="relative" ref={addMenuRef}>
            <button
              onClick={() => setShowAddMenu(!showAddMenu)}
              className="p-1.5 rounded-md bg-orange-600 text-white hover:bg-orange-700 transition-colors"
              title="新建笔记"
            >
              <Plus size={15} />
            </button>
            {showAddMenu && (
              <div className={`absolute right-0 top-full mt-1 w-44 rounded-lg shadow-lg border z-50 py-1 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
                {EDITABLE_NOTE_TYPES.map((key) => {
                  const { icon, color } = TYPE_ICON[key];
                  return (
                    <button
                      key={key}
                      onClick={() => handleCreate(key)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      <span className={color}>{icon}</span>
                      {TYPE_LABEL[key]}
                    </button>
                  );
                })}
                {onImportDocument && (
                  <>
                    <div className={`my-1 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`} />
                    <button
                      onClick={() => { setShowAddMenu(false); onImportDocument(); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      <span className="text-blue-600 dark:text-blue-400"><FileType size={14} /></span>
                      导入文档…
                    </button>
                  </>
                )}
                {onOpenTemplateGallery && (
                  <>
                    <div className={`my-1 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`} />
                    <button
                      onClick={() => { setShowAddMenu(false); onOpenTemplateGallery(); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      <span className="text-orange-500"><BookTemplate size={14} /></span>
                      从模板创建
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Category tabs */}
      <div className={`px-3 pt-2 pb-1 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex gap-1">
          {CATEGORY_TABS.map(tab => {
            const active = selectedCategory.type === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setSelectedCategory({ type: tab.key })}
                title={tab.label}
                aria-label={tab.label}
                aria-pressed={active}
                className={`p-1.5 rounded-md transition-colors ${
                  active
                    ? 'bg-orange-600 text-white'
                    : (isDark ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100')
                }`}
              >
                {tab.icon}
              </button>
            );
          })}
        </div>
        {selectedCategory.type === 'folder' && (
          <div className={`mt-2 flex items-center gap-1 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            <Folder size={12} className="text-amber-400 shrink-0" />
            <span className="truncate flex-1">
              {folders.find(f => f.id === selectedCategory.folderId)?.name ?? '文件夹'}
            </span>
            <button
              onClick={() => setSelectedCategory({ type: 'all' })}
              className={`shrink-0 px-1.5 py-0.5 rounded ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
            >
              返回全部
            </button>
          </div>
        )}
      </div>

      {/* Search */}
      <div className={`px-[var(--app-gutter)] py-2 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="relative">
          <Search size={14} className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder={isMobile ? '搜索笔记' : '搜索笔记 (⌘+⇧+F)'}
            className={`w-full pl-8 pr-3 py-1.5 text-sm rounded-lg border outline-none transition-colors ${
              isDark
                ? 'bg-gray-800 border-gray-600 text-white placeholder-gray-500 focus:border-orange-500'
                : 'bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400 focus:border-orange-500'
            }`}
          />
        </div>
        {searchQuery && (
          <p className={`text-xs mt-1 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
            已搜索标题、描述及笔记内容
          </p>
        )}
        {/* 类型筛选与标签筛选同处一行：全部改为图标按钮，横向占用最小，把宽度留给笔记列表 */}
        <div className="flex items-center gap-1 mt-2">
          {/* 「全部」无专属类型图标，用 LayoutGrid 表示全量 */}
          <button
            onClick={() => setFilterType('all')}
            title="全部类型"
            aria-label="全部类型"
            aria-pressed={filterType === 'all'}
            className={`p-1 rounded-md transition-colors ${
              filterType === 'all'
                ? 'bg-orange-600 text-white'
                : (isDark ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100')
            }`}
          >
            <LayoutGrid size={14} />
          </button>
          {NOTE_TYPES.map(key => {
            const cfg = TYPE_ICON[key];
            const active = filterType === key;
            return (
              <button
                key={key}
                onClick={() => setFilterType(key)}
                title={`只看${TYPE_LABEL[key]}`}
                aria-label={`只看${TYPE_LABEL[key]}`}
                aria-pressed={active}
                className={`p-1 rounded-md transition-colors ${
                  active
                    ? 'bg-orange-600 text-white'
                    : `${cfg.color} ${isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`
                }`}
              >
                {cfg.icon}
              </button>
            );
          })}
          {/* Tag filter：始终显示入口。
              早期版本用 allTags.length > 0 做了条件渲染，导致「一个标签都没有」
              的全新账号 / 标签被清空后，按钮直接消失且无处可去，
              用户没法再建标签、也无法进入标签管理。入口改为常显，
              菜单内再根据有无标签给出空态说明。 */}
          {!isTrashView && (
            <div ref={tagMenuRef} className="relative shrink-0 ml-auto">
              <div className="flex items-center justify-end gap-1">
                <button
                  type="button"
                  onClick={() => setShowTagMenu(v => !v)}
                  title="按标签筛选"
                  aria-label="按标签筛选"
                  aria-expanded={showTagMenu}
                  className={`relative p-1 rounded-md transition-colors ${
                    selectedTagIds.length > 0
                      ? 'bg-orange-600 text-white'
                      : (isDark ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100')
                  }`}
                >
                  <Tag size={14} />
                  {selectedTagIds.length > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 inline-flex items-center justify-center min-w-[13px] h-[13px] px-0.5 rounded-full bg-orange-600 text-white text-[9px] leading-none ring-1 ring-white dark:ring-gray-800">
                      {selectedTagIds.length}
                    </span>
                  )}
                  <ChevronDown size={9} className={`absolute -bottom-0.5 -right-0.5 transition-transform ${showTagMenu ? 'rotate-180' : ''}`} />
                </button>
                {/* 已选标签以 chip 呈现，点击即可移除 */}
                {allTags.filter(t => selectedTagIds.includes(t.id)).map(tag => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => toggleTagFilter(tag.id)}
                    title={`移除标签：${tag.name}`}
                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-xs rounded-full border border-transparent text-white"
                    style={{ backgroundColor: tag.color }}
                  >
                    <span className="max-w-[72px] truncate">{tag.name}</span>
                    <X size={12} />
                  </button>
                ))}
              </div>
              {showTagMenu && (
                /* 右对齐 + 固定宽度：标签按钮位于筛选行最右，下拉向左展开并与侧边栏右缘对齐，不会溢出面板 */
                <div className={`absolute right-0 top-full z-30 mt-1 w-56 max-w-[calc(100vw-2rem)] max-h-56 overflow-y-auto p-2 flex flex-wrap content-start gap-1 rounded-lg shadow-lg border ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
                  {allTags.length === 0 && (
                    /* 入口常显后必然会出现「一个标签都没有」的情形，给出明确指引而不是空白弹窗 */
                    <p className={`w-full px-1 py-2 text-xs leading-relaxed ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                      还没有任何标签。在笔记编辑器里打开一篇笔记，
                      点标题旁的 <Tag size={11} className="inline align-[-1px]" /> 按钮即可新建。
                    </p>
                  )}
                  {allTags.map(tag => {
                    const active = selectedTagIds.includes(tag.id);
                    return (
                      <button
                        key={tag.id}
                        type="button"
                        onClick={() => toggleTagFilter(tag.id)}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded-full border transition-colors ${
                          active
                            ? 'border-transparent text-white'
                            : isDark ? 'border-gray-600 text-gray-400 hover:bg-gray-700' : 'border-gray-200 text-gray-500 hover:bg-gray-100'
                        }`}
                        style={active
                          ? { backgroundColor: tag.color }
                          : { borderColor: `${tag.color}40`, color: tag.color }}
                      >
                        {active && <Check size={12} />}
                        {tag.name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 批量操作条：勾选任意笔记后浮现，替代逐条右键操作 */}
        {showCheckboxes && checkedIds.length > 0 && (
          <div className={`flex flex-wrap items-center gap-1.5 mx-2 mt-2 px-2 py-1.5 rounded-lg border ${
            isDark ? 'border-gray-700 bg-gray-800' : 'border-orange-200 bg-orange-50'
          }`}>
            <span className={`text-xs font-medium ${isDark ? 'text-orange-300' : 'text-orange-700'}`}>
              已选 {checkedIds.length}
            </span>

            {/* 全选 / 取消全选 */}
            <button
              type="button"
              onClick={toggleCheckAll}
              title={checkedIds.length === sortedNotes.length ? '取消全选' : '全选当前结果'}
              className={`p-1 rounded transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-white'}`}
            >
              {checkedIds.length === sortedNotes.length ? <CheckSquare size={13} /> : <Square size={13} />}
            </button>

            <span className={`w-px h-3.5 ${isDark ? 'bg-gray-700' : 'bg-orange-200'}`} />

            {/* 置顶 */}
            {onPinNote && (
              <button
                type="button"
                onClick={() => handleBatchPin(true)}
                title="批量置顶"
                className={`p-1 rounded transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-white'}`}
              >
                <Pin size={13} />
              </button>
            )}
            {/* 收藏 */}
            {onToggleFavorite && (
              <button
                type="button"
                onClick={() => handleBatchFavorite(true)}
                title="批量收藏"
                className={`p-1 rounded transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-white'}`}
              >
                <Star size={13} />
              </button>
            )}
            {/* 移动到文件夹 */}
            <div className="relative" ref={batchMenuRef}>
              <button
                type="button"
                onClick={() => setShowBatchMenu(v => !v)}
                title="批量移动到文件夹"
                className={`p-1 rounded transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-white'}`}
              >
                <FolderInput size={13} />
              </button>
              {showBatchMenu && (
                <div className={`absolute left-0 top-full z-40 mt-1 w-44 max-h-56 overflow-y-auto rounded-lg shadow-lg border py-1 ${
                  isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                }`}>
                  <button
                    onClick={() => { setShowBatchMenu(false); handleBatchMove(null); }}
                    className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                  >
                    根目录
                  </button>
                  {folderOptions.map(f => (
                    <button
                      key={f.id}
                      onClick={() => { setShowBatchMenu(false); handleBatchMove(f.id); }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      {f.depth > 0 && <span className="opacity-50">{'\u00a0\u00a0'.repeat(f.depth)}</span>}
                      {f.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {/* 删除 */}
            <button
              type="button"
              onClick={handleBatchDelete}
              title="批量删除"
              className={`p-1 rounded transition-colors ${isDark ? 'text-red-400 hover:bg-red-950/40' : 'text-red-500 hover:bg-red-50'}`}
            >
              <Trash2 size={13} />
            </button>

            <span className="flex-1" />
            <button
              type="button"
              onClick={clearChecked}
              title="取消选择"
              className={`p-1 rounded transition-colors ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-white'}`}
            >
              <X size={13} />
            </button>
          </div>
        )}

        {/* Project filter */}
        {!isTrashView && projects.length > 0 && onFilterProjectIdChange && (
          <select
            value={filterProjectId}
            onChange={e => onFilterProjectIdChange(e.target.value)}
            className={`mt-1.5 w-full text-xs px-2 py-1 rounded border outline-none ${
              isDark ? 'bg-gray-800 border-gray-600 text-gray-300' : 'bg-gray-50 border-gray-200 text-gray-600'
            }`}
          >
            <option value="">全部项目</option>
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        )}
      </div>

      {/* Tree / flat list —— 虚拟滚动：只渲染可视区的行，避免 500+ 笔记全量渲染卡顿 */}
      <div
        ref={setScrollContainer}
        role="listbox"
        aria-label="笔记列表"
        aria-multiselectable={showCheckboxes}
        className="flex-1 overflow-y-auto py-1"
      >
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-orange-600"></div>
          </div>
        ) : flatRows.length === 0 ? (
          renderEmptyState()
        ) : (
          <>
            {scrollContainer && draggingNoteId && (
            /* 拖拽悬停时在列表顶部提供「移回根目录」的落点 */
            <div
              onDragOver={e => { e.preventDefault(); setDropFolderId('__root__'); }}
              onDragLeave={() => setDropFolderId(cur => (cur === '__root__' ? null : cur))}
              onDrop={e => handleDrop(e, null)}
              className={`mx-2 mb-1 px-3 py-1.5 rounded-lg text-xs text-center border border-dashed transition-colors ${
                dropFolderId === '__root__'
                  ? (isDark ? 'border-orange-500 bg-orange-900/30 text-orange-300' : 'border-orange-400 bg-orange-100 text-orange-700')
                  : (isDark ? 'border-gray-700 text-gray-500' : 'border-gray-300 text-gray-400')
              }`}
            >
              松开鼠标移回根目录
            </div>
          )}
          {/* 用一个等高占位容器撑开滚动高度，内部按 virtualItems 绝对定位渲染 */}
            <div style={{ height: `${totalSize}px`, position: 'relative', width: '100%' }}>
              {virtualItems.map(vItem => {
                const row = flatRows[vItem.index];
                if (!row) return null;
                return (
                  <div
                    key={vItem.key}
                    ref={measureRow}
                    data-index={vItem.index}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${vItem.start}px)`,
                    }}
                  >
                    {row.kind === 'folder'
                      ? renderFolderRow(row.node)
                      : row.kind === 'newFolder'
                        ? renderNewFolderRow(newFolderParent ?? null, row.level)
                        : renderNoteItem(row.note, row.level)}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* Footer count */}
      <div className={`px-4 py-2 border-t text-xs shrink-0 ${isDark ? 'border-gray-700 text-gray-500' : 'border-gray-200 text-gray-400'}`}>
        共 {displayCount} 篇
      </div>

      {/* 本地同步进度遮罩 */}
      {syncingLocal && syncProgress ? (
        <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/40">
          <div className={`rounded-xl shadow-2xl border px-6 py-5 min-w-[240px] text-center ${
            isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
          }`}>
            <FolderSync size={24} className={`mx-auto mb-3 ${isDark ? 'text-orange-400' : 'text-orange-600'}`} />
            <p className={`text-sm font-medium mb-1 ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
              {syncProgress.phase || '正在同步…'}
            </p>
            <p className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              {syncProgress.total > 0
                ? `${syncProgress.done} / ${syncProgress.total}`
                : '正在处理…'}
            </p>
          </div>
        </div>
      ) : null}

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={`fixed rounded-xl shadow-xl border z-[9999] overflow-hidden py-1 w-40 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
          style={{
            // 钳制到视口内，避免在屏幕右 / 下边缘处溢出（移动端点击三点菜单时尤为明显）
            left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 168)),
            top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 260)),
          }}
        >
          {contextMenu.type === 'note' && isTrashView && (
            <>
              <button
                onClick={() => { onRestoreNote?.(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <RotateCcw size={13} /> 恢复笔记
              </button>
              <div className={`h-px my-0.5 ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`} />
              <button
                onClick={() => { onPermanentDeleteNote?.(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 ${isDark ? 'hover:bg-red-900/20' : 'hover:bg-red-50'}`}
              >
                <Trash2 size={13} /> 永久删除
              </button>
            </>
          )}
          {contextMenu.type === 'note' && !isTrashView && (
            <>
              {(() => {
                const note = notes.find(n => n.id === contextMenu.id);
                return (
                  <>
                    <button
                      onClick={() => { onToggleFavorite?.(contextMenu.id, !!note?.isFavorite); setContextMenu(null); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      <Star size={13} className={note?.isFavorite ? 'fill-amber-400 text-amber-400' : ''} />
                      {note?.isFavorite ? '取消收藏' : '收藏笔记'}
                    </button>
                    <button
                      onClick={() => { onPinNote?.(contextMenu.id, !note?.isPinned); setContextMenu(null); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      {note?.isPinned ? <PinOff size={13} /> : <Pin size={13} />}
                      {note?.isPinned ? '取消置顶' : '置顶笔记'}
                    </button>
                  </>
                );
              })()}
              <button
                onClick={() => { onDuplicateNote?.(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <Copy size={13} /> 复制笔记
              </button>
              <button
                onClick={() => { setMovingNoteId(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <FolderInput size={13} /> 移动到文件夹
              </button>
              {/* 加密文档相关操作：自身未加密且不受加密文件夹保护时才允许加密 */}
              {(() => {
                const note = notes.find(n => n.id === contextMenu.id);
                if (!note) return null;
                const selfEncrypted = !!note.isEncrypted;
                const folderProtected = !!note.folderId && encryptedFolderIds.has(note.folderId);
                // 已在本会话解锁则不再提示解锁（列表接口不带票据，需前端兜底判断）
                const tokenScope: 'note' | 'folder' = selfEncrypted
                  ? 'note'
                  : (note.lockedScope === 'folder' ? 'folder' : 'folder');
                const tokenId = selfEncrypted ? note.id : (note.lockedId ?? note.folderId ?? '');
                const unlocked = (selfEncrypted || folderProtected)
                  && !!tokenId
                  && getUnlockToken(tokenScope, tokenId) !== null;
                return (
                  <>
                    {!selfEncrypted && !folderProtected && note.noteType !== 'document' && (
                      <button
                        onClick={() => { onNoteLockAction?.('encrypt', contextMenu.id); setContextMenu(null); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                      >
                        <Lock size={13} /> 加密文档
                      </button>
                    )}
                    {!unlocked && (selfEncrypted || folderProtected) && (
                      <button
                        onClick={() => { onNoteLockAction?.('unlock', contextMenu.id); setContextMenu(null); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                      >
                        <Unlock size={13} /> 解锁文档
                      </button>
                    )}
                    {selfEncrypted && (
                      <>
                        <button
                          onClick={() => { onNoteLockAction?.('changePassword', contextMenu.id); setContextMenu(null); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <KeyRound size={13} /> 修改密码
                        </button>
                        <button
                          onClick={() => { onNoteLockAction?.('decrypt', contextMenu.id); setContextMenu(null); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <LockOpen size={13} /> 取消加密
                        </button>
                      </>
                    )}
                  </>
                );
              })()}
              <div className={`h-px my-0.5 ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`} />
              <button
                onClick={() => { onDeleteNote(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 ${isDark ? 'hover:bg-red-900/20' : 'hover:bg-red-50'}`}
              >
                <Trash2 size={13} /> 删除
              </button>
            </>
          )}
          {contextMenu.type === 'folder' && (
            <>
              {/* 文件夹加密：祖先已加密时无需重复加密 */}
              {(() => {
                const folder = folders.find(f => f.id === contextMenu.id);
                if (!folder) return null;
                const protectedByAncestor = !!folder.parentId && encryptedFolderIds.has(folder.parentId);
                return (
                  <>
                    {!folder.isEncrypted && !protectedByAncestor && !folder.isSystem && (
                      <button
                        onClick={() => { onFolderLockAction?.('encrypt', contextMenu.id); setContextMenu(null); }}
                        className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                      >
                        <Lock size={13} /> 加密文件夹
                      </button>
                    )}
                    {folder.isEncrypted && (
                      <>
                        <button
                          onClick={() => { onFolderLockAction?.('unlock', contextMenu.id); setContextMenu(null); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <Unlock size={13} /> 解锁文件夹
                        </button>
                        <button
                          onClick={() => { onFolderLockAction?.('decrypt', contextMenu.id); setContextMenu(null); }}
                          className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                        >
                          <LockOpen size={13} /> 取消加密
                        </button>
                      </>
                    )}
                  </>
                );
              })()}
              <button
                onClick={() => {
                  const folder = folders.find(f => f.id === contextMenu.id);
                  if (folder) { setRenamingFolderId(folder.id); setRenameValue(folder.name); }
                  setContextMenu(null);
                }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <Pencil size={13} /> 重命名
              </button>
              <button
                onClick={() => { startNewFolder(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
              >
                <FolderPlus size={13} /> 新建子文件夹
              </button>
              <div className={`h-px my-0.5 ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`} />
              {(() => {
                const folder = folders.find(f => f.id === contextMenu.id);
                // 系统文件夹（知识库根）由后端保护，界面上不放删除入口
                if (folder?.isSystem || folder?.id === kbRootId) {
                  return (
                    <p className="px-3 py-2 text-[11px] text-gray-400">
                      系统文件夹受保护，不可删除或移动
                    </p>
                  );
                }
                return (
                  <button
                    onClick={() => { onDeleteFolder(contextMenu.id); setContextMenu(null); }}
                    className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 ${isDark ? 'hover:bg-red-900/20' : 'hover:bg-red-50'}`}
                  >
                    <Trash2 size={13} /> 删除文件夹
                  </button>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Move-to-folder modal */}
      {renderMoveModal()}
    </div>
  );
};

export default NoteListPanel;
