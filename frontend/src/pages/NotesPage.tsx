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
import {
  noteApi, noteFolderApi, noteTemplateApi, noteTagApi,
  type Note, type NoteCreate, type NoteUpdate, type NoteFolder, type NoteTag,
} from '../services/note';
import NoteListPanel, { type NoteCategory } from '../components/note/NoteListPanel';
import NoteEditorPanel from '../components/note/NoteEditorPanel';
import NoteTemplateGallery from '../components/note/NoteTemplateGallery';

const NotesPage: React.FC = () => {
  const { theme, setPageAIContext, bumpNotesRefresh, notesRefreshToken } = useApp();
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
    } catch {
      toast.error('加载笔记失败');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, filterType, selectedTagIds, activeFolderId, selectedCategory.type]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  // 空闲时预加载常用编辑器 chunk，减少首次打开延迟
  useEffect(() => {
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
      contextHint,
      quickActions: selectedNote ? [
        { label: '总结', prompt: `请总结当前笔记「${selectedNote.title}」` },
        { label: '续写', prompt: `请续写当前笔记「${selectedNote.title}」` },
        { label: '优化', prompt: `请优化润色当前笔记「${selectedNote.title}」` },
      ] : [
        { label: '创建笔记', prompt: '帮我创建一条新笔记' },
      ],
      selectedEntities: selectedNote
        ? [{ type: 'note', id: selectedNote.id, name: selectedNote.title }]
        : undefined,
    });
    return () => setPageAIContext(null);
  }, [setPageAIContext, selectedNote, selectedCategory, folders]);

  // Create note
  const resolveCreateFolderId = useCallback((): string | undefined => {
    if (selectedCategory.type === 'folder') return selectedCategory.folderId;
    return undefined;
  }, [selectedCategory]);

  const handleCreateNote = useCallback(async (noteType: string, folderId?: string) => {
    try {
      const data: NoteCreate = {
        title: '无标题笔记',
        noteType: noteType as NoteCreate['noteType'],
        folderId: folderId || resolveCreateFolderId(),
      };
      const newNote = await noteApi.create(data);
      setNotes(prev => [newNote, ...prev]);
      setNotesTotal(t => t + 1);
      setSelectedNote(newNote);
      toast.success('笔记已创建');
    } catch {
      toast.error('创建失败');
    }
  }, [resolveCreateFolderId]);

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
    } catch {
      toast.error('从模板创建失败');
    }
  }, [resolveCreateFolderId]);

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
      if (selectedNote?.id === id) setSelectedNote(null);
      fetchNotes();
    } catch {
      toast.error('删除失败');
    }
  }, [selectedNote, fetchNotes, selectedCategory.type]);

  const handleRestoreNote = useCallback(async (id: string) => {
    try {
      const restored = await noteApi.restore(id);
      toast.success('笔记已恢复');
      fetchNotes();
      setSelectedNote(restored);
    } catch {
      toast.error('恢复失败');
    }
  }, [fetchNotes]);

  const handlePermanentDeleteNote = useCallback(async (id: string) => {
    if (!confirm('确定永久删除这条笔记吗？此操作无法恢复。')) return;
    try {
      await noteApi.permanentDelete(id);
      toast.success('笔记已永久删除');
      if (selectedNote?.id === id) setSelectedNote(null);
      fetchNotes();
    } catch {
      toast.error('删除失败');
    }
  }, [selectedNote, fetchNotes]);

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
    } catch {
      toast.error('操作失败');
    }
  }, [fetchNotes]);

  const handleDuplicateNote = useCallback(async (id: string) => {
    try {
      const copied = await noteApi.duplicate(id);
      toast.success('笔记已复制');
      fetchNotes();
      setSelectedNote(copied);
    } catch {
      toast.error('复制失败');
    }
  }, [fetchNotes]);

  const handlePinNote = useCallback(async (id: string, pinned: boolean) => {
    try {
      await noteApi.update(id, { isPinned: pinned } as NoteUpdate);
      toast.success(pinned ? '笔记已置顶' : '已取消置顶');
      fetchNotes();
    } catch {
      toast.error('操作失败');
    }
  }, [fetchNotes]);

  // Move note to folder
  const handleMoveNote = useCallback(async (noteId: string, folderId: string | null) => {
    try {
      await noteApi.update(noteId, { folderId: folderId ?? undefined });
      toast.success('笔记已移动');
      fetchNotes();
    } catch {
      toast.error('移动失败');
    }
  }, [fetchNotes]);

  // Folder CRUD
  const handleCreateFolder = useCallback(async (name: string, parentId?: string) => {
    try {
      await noteFolderApi.create({ name, parentId });
      toast.success('文件夹已创建');
      fetchNotes();
    } catch {
      toast.error('创建文件夹失败');
    }
  }, [fetchNotes]);

  const handleRenameFolder = useCallback(async (id: string, name: string) => {
    try {
      await noteFolderApi.update(id, { name });
      toast.success('文件夹已重命名');
      fetchNotes();
    } catch {
      toast.error('重命名失败');
    }
  }, [fetchNotes]);

  const handleDeleteFolder = useCallback(async (id: string) => {
    if (!confirm('删除文件夹？其中的笔记将移至根目录。')) return;
    try {
      await noteFolderApi.delete(id);
      toast.success('文件夹已删除');
      fetchNotes();
    } catch {
      toast.error('删除文件夹失败');
    }
  }, [fetchNotes]);

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
