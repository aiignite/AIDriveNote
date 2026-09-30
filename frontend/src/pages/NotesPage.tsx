/**
 * NotesPage – AIDriveNote 笔记管理（两栏布局）
 *
 * 左侧笔记列表面板（含文件夹树、分类筛选）+ 右侧编辑器面板
 * 支持可拖拽调整宽度、全屏模式、暗色主题、文件夹管理
 */
import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  FileText,
  Code2, Brain, GitFork,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useApp } from '../contexts/AppContext';
import { useAuth } from '../contexts/AuthContext';
import { buildNoteQuickActions } from '../utils/noteAIActions';
import { isNetworkError } from '../services/client';
import {
  noteApi, noteFolderApi, noteTemplateApi, noteTagApi,
  type Note, type NoteCreate, type NoteUpdate, type NoteFolder, type NoteTag,
} from '../services/note';
import {
  cacheList, cacheNoteMetas, dropCached, readAllNotes, readList, readNote, toNote,
} from '../services/offline/noteCache';
import {
  createOfflineNote, deleteOfflineNote, saveOfflineEdit,
} from '../services/offline/offlineQueue';
import type { OutboxPayload } from '../services/offline/offlineDb';
import NoteListPanel, { type NoteCategory } from '../components/note/NoteListPanel';
import NoteEditorPanel from '../components/note/NoteEditorPanel';
import NoteTemplateGallery from '../components/note/NoteTemplateGallery';

const NotesPage: React.FC = () => {
  const { theme, setPageAIContext, bumpNotesRefresh, notesRefreshToken } = useApp();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const isDark = theme === 'dark';

  // Notes data
  const [notes, setNotes] = useState<Note[]>([]);
  const [folders, setFolders] = useState<NoteFolder[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterType, setFilterType] = useState<string>('all');
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<NoteTag[]>([]);
  const [notesTotal, setNotesTotal] = useState(0);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [editorRefreshTrigger, setEditorRefreshTrigger] = useState(0);
  const [showNewNotePopover, setShowNewNotePopover] = useState(false);
  const [showTemplateGallery, setShowTemplateGallery] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<NoteCategory>({ type: 'all' });
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Sidebar width (draggable)
  const [leftWidth, setLeftWidth] = useState(320);
  const [isDragging, setIsDragging] = useState(false);
  const dragStartXRef = useRef(0);
  const dragStartWidthRef = useRef(0);

  // Debounce search input
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const activeFolderId =
    selectedCategory.type === 'folder' ? selectedCategory.folderId : undefined;

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
      if (e.key === 'Escape') setShowNewNotePopover(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
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
      recommendedAssistant: '笔记助手',
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

  // Create note
  const resolveCreateFolderId = useCallback((): string | undefined => {
    if (selectedCategory.type === 'folder') return selectedCategory.folderId;
    return undefined;
  }, [selectedCategory]);

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
  const handleDeleteNote = useCallback(async (id: string) => {
    const isTrash = selectedCategory.type === 'trash';
    const msg = isTrash
      ? '确定永久删除这条笔记吗？此操作无法恢复。'
      : '确定删除这条笔记吗？笔记将移入回收站。';
    if (!confirm(msg)) return;
    try {
      if (isTrash) {
        await noteApi.permanentDelete(id);
        toast.success('笔记已永久删除');
      } else {
        await noteApi.delete(id);
        toast.success('笔记已移入回收站');
      }
      void dropCached([id]);
      if (selectedNote?.id === id) setSelectedNote(null);
      fetchNotes();
    } catch (err) {
      // 离线删除：本地立即移除，服务端删除排队等待回传
      if (isNetworkError(err) && !isTrash) {
        const cached = await readNote(id);
        if (cached) {
          await deleteOfflineNote(cached);
          if (selectedNote?.id === id) setSelectedNote(null);
          setNotes(prev => prev.filter(n => n.id !== id));
          setNotesTotal(t => Math.max(0, t - 1));
          toast.success('已离线删除，联网后将自动同步');
          return;
        }
      }
      toast.error('删除失败');
    }
  }, [selectedNote, fetchNotes, selectedCategory.type]);

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
      if (selectedNote?.id === id) setSelectedNote(null);
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('删除失败');
    }
  }, [selectedNote, fetchNotes, notifyIfOffline]);

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

  const handleDeleteFolder = useCallback(async (id: string) => {
    if (!confirm('删除文件夹？其中的笔记将移至根目录。')) return;
    try {
      await noteFolderApi.delete(id);
      toast.success('文件夹已删除');
      fetchNotes();
    } catch (err) {
      if (notifyIfOffline(err)) return;
      toast.error('删除文件夹失败');
    }
  }, [fetchNotes, notifyIfOffline]);

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

  useEffect(() => {
    if (notes.length === 0) return;
    const lastId = localStorage.getItem('note_last_opened_id');
    if (lastId && !selectedNote) {
      const found = notes.find(n => n.id === lastId);
      if (found) setSelectedNote(found);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notes]);

  // Resize drag handlers
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartXRef.current = e.clientX;
    dragStartWidthRef.current = leftWidth;
  }, [leftWidth]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const diff = e.clientX - dragStartXRef.current;
      const newWidth = Math.max(240, Math.min(600, dragStartWidthRef.current + diff));
      setLeftWidth(newWidth);
    };
    const handleMouseUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const combinedRefreshTrigger = editorRefreshTrigger + notesRefreshToken;

  return (
    <div className={`h-[calc(100vh-56px)] flex overflow-hidden ${isFullscreen ? 'fixed inset-0 z-50' : ''} ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Left: Note list panel */}
        <div
          className={`shrink-0 border-r ${isDark ? 'border-gray-700' : 'border-gray-200'}`}
          style={{ width: leftWidth }}
        >
          <NoteListPanel
            notes={notes}
            folders={folders}
            allTags={allTags}
            notesTotal={notesTotal}
            selectedNoteId={selectedNote?.id || null}
            onSelectNote={handleSelectNote}
            onCreateNote={handleCreateNote}
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
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen(f => !f)}
          />
        </div>

        {/* Resize handle */}
        <div
          onMouseDown={handleMouseDown}
          className={`w-1 cursor-col-resize hover:bg-orange-500/50 transition-colors shrink-0 ${isDragging ? 'bg-orange-500/50' : ''}`}
        />

        {/* Right: Editor panel */}
        <div className="flex-1 min-w-0 h-full min-h-0">
          {selectedNote ? (
            <NoteEditorPanel
              note={selectedNote}
              folders={folders}
              allTags={allTags}
              onNoteUpdated={handleNoteUpdated}
              onTagsChanged={handleEditorTagsChanged}
              isDark={isDark}
              refreshTrigger={combinedRefreshTrigger}
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
            </div>
          )}
        </div>

      {/* Ctrl+N new note popover */}
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
    </div>
  );
};

export default NotesPage;
