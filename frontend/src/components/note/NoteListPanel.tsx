/**
 * NoteListPanel – 笔记列表面板（参照 AIIgniteNote 风格）
 *
 * 特性：文件夹树 + 简洁笔记列表 + 右键菜单 + 搜索筛选
 */
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Search, Plus, FileText, Code2, Brain, GitFork,
  MoreHorizontal, Trash2, ArrowUpDown, Folder, FolderOpen,
  FolderPlus, ChevronRight, ChevronDown, Pencil, FolderInput, Copy, Pin, PinOff,
  BookTemplate, RotateCcw, Star, RefreshCw, Maximize2, Minimize2,
} from 'lucide-react';
import type { Note, NoteFolder, NoteTag } from '../../services/note';

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


const CATEGORY_TABS: { key: Exclude<NoteCategory['type'], 'folder'>; label: string }[] = [
  { key: 'all', label: '全部笔记' },
  { key: 'recent', label: '最近' },
  { key: 'pinned', label: '置顶' },
  { key: 'favorites', label: '收藏' },
  { key: 'trash', label: '回收站' },
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

export interface NoteListPanelProps {
  notes: Note[];
  folders: NoteFolder[];
  allTags?: NoteTag[];
  notesTotal?: number;
  selectedNoteId: string | null;
  onSelectNote: (note: Note) => void;
  onCreateNote: (noteType: string, folderId?: string) => void;
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
}

const NoteListPanel: React.FC<NoteListPanelProps> = ({
  notes,
  folders,
  allTags = [],
  notesTotal,
  selectedNoteId,
  onSelectNote,
  onCreateNote,
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
}) => {
  const [internalCategory, setInternalCategory] = useState<NoteCategory>({ type: 'all' });
  const selectedCategory = selectedCategoryProp ?? internalCategory;
  const isTrashView = selectedCategory.type === 'trash';
  const setSelectedCategory = useCallback((cat: NoteCategory) => {
    if (!selectedCategoryProp) setInternalCategory(cat);
    onCategoryChange?.(cat);
  }, [selectedCategoryProp, onCategoryChange]);
  const [sortMode, setSortMode] = useState<SortMode>('updatedAt');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [showSortMenu, setShowSortMenu] = useState(false);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [internalFilterType, setInternalFilterType] = useState<string>('all');
  const filterType = filterTypeProp ?? internalFilterType;
  const setFilterType = useCallback((type: string) => {
    if (filterTypeProp === undefined) setInternalFilterType(type);
    onFilterTypeChange?.(type);
  }, [filterTypeProp, onFilterTypeChange]);
  const [internalSelectedTagIds, setInternalSelectedTagIds] = useState<string[]>([]);
  const selectedTagIds = selectedTagIdsProp ?? internalSelectedTagIds;
  const toggleTagFilter = useCallback((tagId: string) => {
    const next = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter(id => id !== tagId)
      : [...selectedTagIds, tagId];
    if (selectedTagIdsProp === undefined) setInternalSelectedTagIds(next);
    onSelectedTagIdsChange?.(next);
  }, [selectedTagIds, selectedTagIdsProp, onSelectedTagIdsChange]);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());
  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number; y: number; type: 'note' | 'folder'; id: string;
  } | null>(null);
  // Inline rename state
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // Move-to-folder modal
  const [movingNoteId, setMovingNoteId] = useState<string | null>(null);
  // New folder inline input
  const [newFolderParent, setNewFolderParent] = useState<string | null | undefined>(undefined);
  const [newFolderName, setNewFolderName] = useState('');

  const sortMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);

  // Close popups on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) setShowSortMenu(false);
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setShowAddMenu(false);
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

  // 递归计算文件夹下的笔记数量（含子文件夹）
  function countNotesInNode(node: TreeNode): number {
    let count = 0;
    for (const child of node.children) {
      if (child.type === 'note') count++;
      else count += countNotesInNode(child);
    }
    return count;
  }

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

  const handleCreate = useCallback((type: string) => {
    const folderId = selectedCategory.type === 'folder' ? selectedCategory.folderId : undefined;
    onCreateNote(type, folderId);
    setShowAddMenu(false);
  }, [onCreateNote, selectedCategory]);

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

  /* ── Render a single note item ─────────────────── */
  const renderNoteItem = (note: Note, level: number) => {
    const isSelected = note.id === selectedNoteId;
    const typeCfg = TYPE_ICON[note.noteType] || TYPE_ICON.rich_text;
    const paddingLeft = level * 16 + 12;

    return (
      <div
        key={note.id}
        onClick={() => onSelectNote(note)}
        onContextMenu={(e) => handleContextMenu(e, 'note', note.id)}
        className={`group flex items-center gap-2.5 px-3 py-2 cursor-pointer rounded-lg mx-1 transition-all ${
          isSelected
            ? (isDark ? 'bg-orange-900/30' : 'bg-orange-50')
            : (isDark ? 'hover:bg-gray-800/50' : 'hover:bg-gray-50')
        }`}
        style={{ paddingLeft: `${paddingLeft}px` }}
      >
        {/* Type icon badge */}
        <div className={`shrink-0 p-1.5 rounded-md ${typeCfg.bgColor}`}>
          <span className={typeCfg.color}>{typeCfg.icon}</span>
        </div>
        {/* Title + time */}
        <div className="flex-1 min-w-0">
          <span className={`block text-sm truncate ${
            isSelected
              ? (isDark ? 'text-orange-300 font-medium' : 'text-orange-700 font-medium')
              : (isDark ? 'text-gray-200' : 'text-gray-700')
          }`}>
            {note.isPinned && <Pin size={10} className="inline mr-1 text-amber-500" />}
            {note.isFavorite && <Star size={10} className="inline mr-1 text-amber-400 fill-amber-400" />}
            {note.title || '无标题'}
          </span>
          {note.previewText && (
            <span className={`block text-xs truncate mt-0.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {note.previewText}
            </span>
          )}
          <div className="flex items-center gap-1 mt-0.5 flex-wrap">
            {note.tags?.slice(0, 2).map(tag => (
              <span
                key={tag.id}
                className="text-[10px] px-1.5 py-0 rounded-full"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
              >
                {tag.name}
              </span>
            ))}
            {(note.tags?.length ?? 0) > 2 && (
              <span className={`text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
                +{(note.tags?.length ?? 0) - 2}
              </span>
            )}
          </div>
          <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
            {formatRelativeTime(note.updatedAt)}
          </span>
        </div>
        {/* Three-dot menu */}
        <button
          onClick={e => { e.stopPropagation(); handleContextMenu(e, 'note', note.id); }}
          className={`p-0.5 rounded opacity-0 group-hover:opacity-100 transition ${isDark ? 'hover:bg-gray-600 text-gray-400' : 'hover:bg-gray-200 text-gray-400'}`}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  };

  /* ── Render a folder node ──────────────────────── */
  const renderFolderNode = (node: TreeNode) => {
    const folder = node.folder!;
    const isExpanded = expandedFolders.has(folder.id);
    const hasChildren = node.children.length > 0;
    const paddingLeft = node.level * 16 + 12;

    return (
      <div key={folder.id}>
        <div
          onClick={() => {
            toggleFolder(folder.id);
            setSelectedCategory({ type: 'folder', folderId: folder.id });
          }}
          onContextMenu={(e) => handleContextMenu(e, 'folder', folder.id)}
          className={`group flex items-center gap-2 px-3 py-1.5 mx-1 rounded-lg cursor-pointer transition-all ${
            isDark ? 'hover:bg-gray-800/50' : 'hover:bg-gray-50'
          }`}
          style={{ paddingLeft: `${paddingLeft}px` }}
        >
          {/* Expand arrow */}
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
              {folder.name}
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
          {/* Hover actions */}
          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={e => { e.stopPropagation(); startNewFolder(folder.id); }}
              className={`p-0.5 rounded ${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-400 hover:text-gray-700'}`}
              title="新建子文件夹"
            >
              <FolderPlus size={13} />
            </button>
          </div>
        </div>
        {/* Expand children */}
        {isExpanded && (
          <div>
            {/* New subfolder input if creating under this folder */}
            {newFolderParent === folder.id && (
              <div className="flex items-center gap-2 px-3 py-1 mx-1" style={{ paddingLeft: `${(node.level + 1) * 16 + 12}px` }}>
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
            )}
            {node.children.map(child => renderTreeNode(child))}
          </div>
        )}
      </div>
    );
  };

  /* ── Render tree node dispatcher ───────────────── */
  const renderTreeNode = (node: TreeNode): React.ReactNode => {
    if (node.type === 'folder') return renderFolderNode(node);
    if (node.type === 'note' && node.note) return renderNoteItem(node.note, node.level);
    return null;
  };

  /* ── Move-to-folder modal ──────────────────────── */
  const renderMoveModal = () => {
    if (!movingNoteId) return null;
    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40" onClick={() => setMovingNoteId(null)}>
        <div
          className={`w-72 max-h-80 rounded-xl shadow-2xl border overflow-hidden ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
          onClick={e => e.stopPropagation()}
        >
          <div className={`px-4 py-3 border-b text-sm font-medium ${isDark ? 'border-gray-700 text-gray-200' : 'border-gray-200 text-gray-800'}`}>
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
      <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <h3 className={`text-sm font-semibold ${isDark ? 'text-gray-200' : 'text-gray-800'}`}>
          笔记 <span className="text-xs font-normal text-gray-400">({notes.length})</span>
        </h3>
        <div className="flex items-center gap-1">
          {onRefresh ? (
            <button
              onClick={() => onRefresh()}
              className={`p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100'}`}
              title="刷新"
            >
              <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
            </button>
          ) : null}
          {onToggleFullscreen ? (
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
                {Object.entries(TYPE_ICON).map(([key, { icon, color }]) => {
                  const labels: Record<string, string> = { rich_text: '富文本', markdown: 'Markdown', mindmap: '思维导图', flowchart: '流程图' };
                  return (
                    <button
                      key={key}
                      onClick={() => handleCreate(key)}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-50'}`}
                    >
                      <span className={color}>{icon}</span>
                      {labels[key]}
                    </button>
                  );
                })}
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
        <div className="flex gap-1 flex-wrap">
          {CATEGORY_TABS.map(tab => (
            <button
              key={tab.key}
              onClick={() => setSelectedCategory({ type: tab.key })}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                selectedCategory.type === tab.key
                  ? (isDark ? 'bg-orange-600 text-white' : 'bg-orange-600 text-white')
                  : (isDark ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-800' : 'text-gray-600 hover:text-gray-800 hover:bg-gray-100')
              }`}
            >
              {tab.label}
            </button>
          ))}
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
      <div className={`px-3 py-2 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="relative">
          <Search size={14} className={`absolute left-2.5 top-1/2 -translate-y-1/2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`} />
          <input
            ref={searchInputRef}
            value={searchQuery}
            onChange={e => onSearchChange(e.target.value)}
            placeholder="搜索笔记 (⌘+⇧+F)"
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
        {/* Type filter tabs */}
        <div className="flex gap-0.5 mt-2 flex-wrap">
          {[
            { key: 'all', label: '全部' },
            { key: 'rich_text', label: '富文本' },
            { key: 'markdown', label: 'MD' },
            { key: 'mindmap', label: '导图' },
            { key: 'flowchart', label: '流程图' },
          ].map(tab => (
            <button
              key={tab.key}
              onClick={() => setFilterType(tab.key)}
              className={`px-2 py-0.5 text-xs rounded-full transition-colors ${
                filterType === tab.key
                  ? (isDark ? 'bg-orange-600 text-white' : 'bg-orange-600 text-white')
                  : (isDark ? 'text-gray-400 hover:text-gray-200 hover:bg-gray-700' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-100')
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        {/* Tag filter */}
        {!isTrashView && allTags.length > 0 && (
          <div className="flex gap-0.5 mt-1.5 flex-wrap">
            {allTags.map(tag => (
              <button
                key={tag.id}
                onClick={() => toggleTagFilter(tag.id)}
                className={`px-2 py-0.5 text-xs rounded-full transition-colors border ${
                  selectedTagIds.includes(tag.id)
                    ? 'border-transparent text-white'
                    : isDark ? 'border-gray-600 text-gray-400' : 'border-gray-200 text-gray-500'
                }`}
                style={selectedTagIds.includes(tag.id)
                  ? { backgroundColor: tag.color }
                  : { borderColor: `${tag.color}40`, color: tag.color }}
              >
                {tag.name}
              </button>
            ))}
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

      {/* Tree / flat list */}
      <div className="flex-1 overflow-y-auto py-1">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-orange-600"></div>
          </div>
        ) : selectedCategory.type !== 'all' ? (
          sortedNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-gray-400">
              <FileText size={24} className="mb-2 opacity-50" />
              <p className="text-xs">暂无笔记</p>
            </div>
          ) : (
            sortedNotes.map(note => renderNoteItem(note, 0))
          )
        ) : tree.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-gray-400">
            <FileText size={24} className="mb-2 opacity-50" />
            <p className="text-xs">暂无笔记</p>
          </div>
        ) : (
          <>
            {/* Root new folder input */}
            {newFolderParent === null && (
              <div className="flex items-center gap-2 px-4 py-1 mx-1">
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
            )}
            {tree.map(node => renderTreeNode(node))}
          </>
        )}
      </div>

      {/* Footer count */}
      <div className={`px-4 py-2 border-t text-xs shrink-0 ${isDark ? 'border-gray-700 text-gray-500' : 'border-gray-200 text-gray-400'}`}>
        共 {displayCount} 篇
      </div>

      {/* Right-click context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className={`fixed rounded-xl shadow-xl border z-[9999] overflow-hidden py-1 w-40 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
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
              <button
                onClick={() => { onDeleteFolder(contextMenu.id); setContextMenu(null); }}
                className={`w-full flex items-center gap-2 px-3 py-2 text-xs text-red-500 ${isDark ? 'hover:bg-red-900/20' : 'hover:bg-red-50'}`}
              >
                <Trash2 size={13} /> 删除文件夹
              </button>
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
