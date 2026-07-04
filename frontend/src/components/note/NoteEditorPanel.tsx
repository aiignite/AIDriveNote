/**
 * NoteEditorPanel – 编辑器主面板（标题内联编辑 + 元信息 + 编辑器容器 + 自动保存）
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Save, FileText, Code2, Brain, GitFork, Download, ChevronDown, Star, History, Link2, Share2, X, Plus, BookTemplate, Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import NoteEditorContainer from './NoteEditorContainer';
import type { NoteMindMapEditorHandle } from './NoteMindMapEditor';
import {
  noteApi, noteTagApi, noteTemplateApi,
  type Note, type NoteUpdate, type NoteFolder, type NoteTag,
  type NoteBacklink, type NoteRevision, type NoteShare,
} from '../../services/note';
import { getExportOptions, type ExportFormat } from '../../utils/noteExportOptions';

const TYPE_META: Record<string, { icon: React.ReactNode; label: string; badgeColor: string }> = {
  rich_text: { icon: <FileText size={14} />, label: '富文本', badgeColor: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400' },
  markdown: { icon: <Code2 size={14} />, label: 'Markdown', badgeColor: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  mindmap: { icon: <Brain size={14} />, label: '思维导图', badgeColor: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  flowchart: { icon: <GitFork size={14} />, label: '流程图', badgeColor: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
};

/** 从不同笔记类型内容中统计字数/节点数 */
function calcStats(noteType: string, content: unknown): string {
  if (!content) return '';
  try {
    if (noteType === 'markdown') {
      const text = typeof content === 'string' ? content
        : (content as any)?.text ?? '';
      const stripped = text.replace(/```[\s\S]*?```|`[^`]*`|#+\s|[*_~>[\]()!]/g, '').trim();
      return `${stripped.length} 字符`;
    }
    if (noteType === 'rich_text') {
      const blocks = Array.isArray(content) ? content
        : ((content as any)?.blocks ?? []);
      const countText = (b: any): number => {
        let n = 0;
        if (Array.isArray(b?.content)) {
          for (const c of b.content) n += (c.text ?? '').length;
        }
        if (Array.isArray(b?.children)) {
          for (const ch of b.children) n += countText(ch);
        }
        return n;
      };
      const total = (blocks as any[]).reduce((acc: number, b: any) => acc + countText(b), 0);
      return `${total} 字符`;
    }
    if (noteType === 'mindmap') {
      const countNodes = (node: any): number => {
        if (!node) return 0;
        let n = 1;
        for (const ch of (node.children ?? [])) n += countNodes(ch);
        return n;
      };
      const nodeCount = countNodes(content as any) - 1; // 减去根节点本身
      return `${nodeCount} 个节点`;
    }
  } catch { /* ignore */ }
  return '';
}

interface NoteEditorPanelProps {
  note: Note;
  folders?: NoteFolder[];
  allTags?: NoteTag[];
  onNoteUpdated?: (note: Note) => void;
  onTagsChanged?: () => void;
  isDark?: boolean;
  refreshTrigger?: number;
}

const NoteEditorPanel: React.FC<NoteEditorPanelProps> = ({
  note,
  folders = [],
  allTags = [],
  onNoteUpdated,
  onTagsChanged,
  isDark = false,
  refreshTrigger,
}) => {
  const [title, setTitle] = useState(note.title);
  const [noteTags, setNoteTags] = useState<NoteTag[]>(note.tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [backlinks, setBacklinks] = useState<NoteBacklink[]>([]);
  const [revisions, setRevisions] = useState<NoteRevision[]>([]);
  const [shares, setShares] = useState<NoteShare[]>([]);
  const [showSidePanel, setShowSidePanel] = useState<'none' | 'backlinks' | 'history' | 'share'>('none');
  const [shareUserId, setShareUserId] = useState('');
  const [sharePermission, setSharePermission] = useState<'view' | 'edit'>('view');
  const [showTagPopover, setShowTagPopover] = useState(false);
  const [showDescField, setShowDescField] = useState(Boolean(note.description));
  const tagPopoverRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [content, setContent] = useState<unknown>(note.content ?? null);
  const [contentResetKey, setContentResetKey] = useState(0);
  const [description, setDescription] = useState(note.description ?? '');
  const [saving, setSaving] = useState(false);

  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentLoadAtRef = useRef(0);
  const contentDirtyRef = useRef(false);
  const noteIdRef = useRef(note.id);
  const lastRefreshTriggerRef = useRef(refreshTrigger);
  const mindMapEditorRef = useRef<NoteMindMapEditorHandle>(null);

  // 切换笔记：先用列表缓存内容即时渲染，后台拉取最新数据
  useEffect(() => {
    noteIdRef.current = note.id;
    contentDirtyRef.current = false;
    setTitle(note.title);
    setNoteTags(note.tags ?? []);
    setDescription(note.description ?? '');
    setShowDescField(Boolean(note.description));
    setShowTagPopover(false);
    setContent(note.content ?? null);
    contentLoadAtRef.current = Date.now();

    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }

    noteApi.get(note.id).then(full => {
      if (noteIdRef.current !== note.id || contentDirtyRef.current) return;
      setContent(full.content ?? null);
      setNoteTags(full.tags ?? []);
    }).catch(() => { /* 保留缓存内容 */ });
  }, [note.id]);

  // 同笔记元数据更新（保存后列表同步）
  useEffect(() => {
    if (noteIdRef.current !== note.id) return;
    setTitle(note.title);
    setNoteTags(note.tags ?? []);
    setDescription(note.description ?? '');
  }, [note.id, note.title, note.tags, note.description]);

  // AI / 全局刷新：强制重载内容与编辑器
  useEffect(() => {
    if (lastRefreshTriggerRef.current === refreshTrigger) return;
    lastRefreshTriggerRef.current = refreshTrigger;

    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }

    contentDirtyRef.current = false;
    noteApi.get(note.id).then(full => {
      if (noteIdRef.current !== note.id) return;
      setContent(full.content ?? null);
      setNoteTags(full.tags ?? []);
      setTitle(full.title);
      setDescription(full.description ?? '');
      setContentResetKey(k => k + 1);
      contentLoadAtRef.current = Date.now();
    }).catch(() => { /* ignore */ });
  }, [refreshTrigger, note.id]);

  useEffect(() => {
    const load = () => {
      noteApi.getBacklinks(note.id).then(setBacklinks).catch(() => setBacklinks([]));
    };
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(load, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const timer = window.setTimeout(load, 150);
    return () => window.clearTimeout(timer);
  }, [note.id, refreshTrigger]);

  const loadRevisions = useCallback(async () => {
    try {
      const revs = await noteApi.listRevisions(note.id);
      setRevisions(revs);
    } catch {
      setRevisions([]);
    }
  }, [note.id]);

  const loadShares = useCallback(async () => {
    try {
      const data = await noteApi.listShares(note.id);
      setShares(data);
    } catch {
      setShares([]);
    }
  }, [note.id]);

  const handleAddTag = useCallback(async (tagName: string) => {
    const name = tagName.trim();
    if (!name) return;
    try {
      let tag = allTags.find(t => t.name === name);
      if (!tag) {
        tag = await noteTagApi.create({ name });
      }
      await noteTagApi.addToNote(note.id, tag.id);
      setNoteTags(prev => prev.some(t => t.id === tag!.id) ? prev : [...prev, tag!]);
      setTagInput('');
      setShowTagPopover(false);
      onTagsChanged?.();
      toast.success('标签已添加');
    } catch {
      toast.error('添加标签失败');
    }
  }, [allTags, note.id, onTagsChanged]);

  const handleRemoveTag = useCallback(async (tagId: string) => {
    try {
      await noteTagApi.removeFromNote(note.id, tagId);
      setNoteTags(prev => prev.filter(t => t.id !== tagId));
      onTagsChanged?.();
    } catch {
      toast.error('移除标签失败');
    }
  }, [note.id, onTagsChanged]);

  const handleRestoreRevision = useCallback(async (revisionId: string) => {
    if (!confirm('确定恢复到此版本？当前内容将保存为历史版本。')) return;
    try {
      const updated = await noteApi.restoreRevision(note.id, revisionId);
      onNoteUpdated?.(updated);
      setContent(updated.content ?? null);
      setTitle(updated.title);
      setContentResetKey(k => k + 1);
      contentLoadAtRef.current = Date.now();
      toast.success('已恢复到选定版本');
      loadRevisions();
    } catch {
      toast.error('恢复失败');
    }
  }, [note.id, onNoteUpdated, loadRevisions]);

  const handleAddShare = useCallback(async () => {
    if (!shareUserId.trim()) return;
    try {
      await noteApi.addShare(note.id, {
        sharedWithUserId: shareUserId.trim(),
        permission: sharePermission,
      });
      setShareUserId('');
      loadShares();
      toast.success('分享已添加');
    } catch {
      toast.error('分享失败，请检查用户 ID');
    }
  }, [note.id, shareUserId, sharePermission, loadShares]);

  const handleRemoveShare = useCallback(async (userId: string) => {
    try {
      await noteApi.removeShare(note.id, userId);
      loadShares();
    } catch {
      toast.error('移除分享失败');
    }
  }, [note.id, loadShares]);

  // Auto-save title (debounce 1s)
  const handleTitleChange = useCallback((newTitle: string) => {
    setTitle(newTitle);
    if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
    titleTimerRef.current = setTimeout(async () => {
      if (!newTitle.trim()) return;
      try {
        const updated = await noteApi.update(note.id, { title: newTitle } as NoteUpdate);
        onNoteUpdated?.(updated);
      } catch {
        // silent
      }
    }, 1000);
  }, [note.id, onNoteUpdated]);

  // Auto-save description (debounce 1s)
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDescriptionChange = useCallback((newDesc: string) => {
    setDescription(newDesc);
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = setTimeout(async () => {
      try {
        await noteApi.update(note.id, { description: newDesc } as NoteUpdate);
      } catch { /* silent */ }
    }, 1000);
  }, [note.id]);

  // Click outside to close tag menu
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (tagPopoverRef.current && !tagPopoverRef.current.contains(e.target as Node)) {
        setShowTagPopover(false);
      }
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  useEffect(() => {
    if (showTagPopover) {
      setTimeout(() => tagInputRef.current?.focus(), 0);
    }
  }, [showTagPopover]);

  // Auto-save content (debounce 2s) — AI 刷新后 1.5s 内忽略编辑器初始化 onChange
  const handleContentChange = useCallback((newContent: unknown) => {
    if (Date.now() - contentLoadAtRef.current < 1500) return;
    contentDirtyRef.current = true;
    setContent(newContent);
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    contentTimerRef.current = setTimeout(async () => {
      try {
        setSaving(true);
        await noteApi.update(note.id, { content: newContent as Record<string, unknown> } as NoteUpdate);
        setSaving(false);
      } catch {
        setSaving(false);
      }
    }, 2000);
  }, [note.id]);

  // Manual save
  const handleManualSave = useCallback(async () => {
    try {
      setSaving(true);
      const data: NoteUpdate = {};
      if (title.trim()) data.title = title;
      if (content !== null) data.content = content as Record<string, unknown>;
      const updated = await noteApi.update(note.id, data);
      onNoteUpdated?.(updated);
      toast.success('已保存');
    } catch {
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  }, [note.id, title, content, onNoteUpdated]);

  const handleSaveAsTemplate = useCallback(async () => {
    const name = prompt('模板名称', `${title || '无标题'} 模板`);
    if (!name?.trim()) return;
    try {
      await noteTemplateApi.create({
        name: name.trim(),
        noteType: note.noteType,
        description: description || undefined,
        content: content != null ? (content as Record<string, unknown>) : undefined,
      });
      toast.success('已另存为模板');
    } catch {
      toast.error('保存模板失败');
    }
  }, [title, description, content, note.noteType]);

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    };
  }, []);

  // Ctrl+S shortcut for manual save
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleManualSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleManualSave]);

  const typeMeta = TYPE_META[note.noteType] || TYPE_META.rich_text;

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header bar */}
      <div className={`flex items-center justify-between px-4 py-2 border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-2 flex-1 min-w-0 flex-wrap">
          {/* Note type badge */}
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${typeMeta.badgeColor}`}>
            {typeMeta.icon} {typeMeta.label}
          </span>
          {/* Note number */}
          <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {note.noteNo}
          </span>
          {/* Folder breadcrumb */}
          {note.folderId && folders.length > 0 && (() => {
            const folder = folders.find(f => f.id === note.folderId);
            return folder ? (
              <span className={`text-xs flex items-center gap-1 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                {folder.name}
              </span>
            ) : null;
          })()}
          {note.isFavorite && (
            <Star size={14} className="text-amber-400 fill-amber-400" />
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => { setShowSidePanel(showSidePanel === 'backlinks' ? 'none' : 'backlinks'); }}
            className={`p-1.5 rounded-lg text-xs ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
            title="反向引用"
          >
            <Link2 size={14} />
          </button>
          <button
            onClick={() => { loadRevisions(); setShowSidePanel(showSidePanel === 'history' ? 'none' : 'history'); }}
            className={`p-1.5 rounded-lg text-xs ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
            title="版本历史"
          >
            <History size={14} />
          </button>
          <button
            onClick={() => { loadShares(); setShowSidePanel(showSidePanel === 'share' ? 'none' : 'share'); }}
            className={`p-1.5 rounded-lg text-xs ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
            title="分享"
          >
            <Share2 size={14} />
          </button>
          {saving && (
            <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>保存中...</span>
          )}
          {/* Export dropdown */}
          <ExportDropdown
            noteType={note.noteType}
            title={title}
            content={content}
            isDark={isDark}
            mindMapRef={note.noteType === 'mindmap' ? mindMapEditorRef : undefined}
          />
          <button
            onClick={handleSaveAsTemplate}
            title="另存为模板"
            className={`p-1.5 rounded-lg text-xs ${isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'}`}
          >
            <BookTemplate size={14} />
          </button>
          <button
            onClick={handleManualSave}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors ${
              isDark
                ? 'bg-orange-600 text-white hover:bg-orange-700'
                : 'bg-orange-600 text-white hover:bg-orange-700'
            }`}
          >
            <Save size={14} /> 保存
          </button>
        </div>
      </div>

      {/* Title row — compact */}
      <div className={`px-4 py-2 border-b ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-100 bg-white'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <input
            value={title}
            onChange={e => handleTitleChange(e.target.value)}
            placeholder="输入标题..."
            className={`flex-1 min-w-0 text-lg font-semibold outline-none bg-transparent ${
              isDark ? 'text-white placeholder-gray-600' : 'text-gray-900 placeholder-gray-300'
            }`}
          />
          {/* Inline tag chips (compact) */}
          <div className="hidden sm:flex items-center gap-1 shrink-0 max-w-[40%] overflow-hidden">
            {noteTags.slice(0, 2).map(tag => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full truncate max-w-[72px]"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                title={tag.name}
              >
                {tag.name}
                <button type="button" onClick={() => handleRemoveTag(tag.id)} className="hover:opacity-70 shrink-0">
                  <X size={9} />
                </button>
              </span>
            ))}
            {noteTags.length > 2 && (
              <span className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>+{noteTags.length - 2}</span>
            )}
          </div>
          {/* Tag popover trigger */}
          <div className="relative shrink-0" ref={tagPopoverRef}>
            <button
              type="button"
              onClick={() => setShowTagPopover(v => !v)}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
                showTagPopover
                  ? (isDark ? 'bg-orange-900/40 text-orange-300' : 'bg-orange-50 text-orange-600')
                  : (isDark ? 'text-gray-400 hover:bg-gray-700 hover:text-gray-200' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700')
              }`}
              title="管理标签"
            >
              <Tag size={13} />
              {noteTags.length > 0 && <span>{noteTags.length}</span>}
            </button>
            {showTagPopover && (
              <div
                className={`absolute right-0 top-full mt-1 z-50 w-56 rounded-lg border shadow-xl p-2 ${
                  isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                }`}
              >
                <p className={`text-[10px] font-medium mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>标签</p>
                {noteTags.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {noteTags.map(tag => (
                      <span
                        key={tag.id}
                        className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full"
                        style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                      >
                        {tag.name}
                        <button type="button" onClick={() => handleRemoveTag(tag.id)} className="hover:opacity-70">
                          <X size={9} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex items-center gap-1">
                  <input
                    ref={tagInputRef}
                    value={tagInput}
                    onChange={e => setTagInput(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter') { e.preventDefault(); void handleAddTag(tagInput); }
                      if (e.key === 'Escape') setShowTagPopover(false);
                    }}
                    placeholder="输入标签名..."
                    className={`flex-1 text-xs px-2 py-1 rounded border outline-none ${
                      isDark ? 'bg-gray-900 border-gray-600 text-gray-200' : 'bg-gray-50 border-gray-200'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => void handleAddTag(tagInput)}
                    className="p-1 rounded bg-orange-600 text-white hover:bg-orange-700"
                  >
                    <Plus size={12} />
                  </button>
                </div>
                {allTags.filter(t => !noteTags.some(nt => nt.id === t.id)).length > 0 && (
                  <div className="mt-2 pt-2 border-t border-dashed flex flex-wrap gap-1 max-h-24 overflow-y-auto"
                    style={{ borderColor: isDark ? '#374151' : '#e5e7eb' }}
                  >
                    {allTags
                      .filter(t => !noteTags.some(nt => nt.id === t.id))
                      .map(tag => (
                        <button
                          key={tag.id}
                          type="button"
                          onClick={() => void handleAddTag(tag.name)}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border transition-colors hover:opacity-80"
                          style={{ borderColor: `${tag.color}40`, color: tag.color }}
                        >
                          + {tag.name}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
        {/* Description — expand on demand */}
        {showDescField || description ? (
          <input
            value={description}
            onChange={e => handleDescriptionChange(e.target.value)}
            placeholder="添加描述..."
            className={`w-full text-xs mt-1 outline-none bg-transparent ${
              isDark ? 'text-gray-400 placeholder-gray-600' : 'text-gray-500 placeholder-gray-400'
            }`}
          />
        ) : (
          <button
            type="button"
            onClick={() => setShowDescField(true)}
            className={`text-[11px] mt-0.5 ${isDark ? 'text-gray-600 hover:text-gray-400' : 'text-gray-400 hover:text-gray-600'}`}
          >
            + 添加描述
          </button>
        )}
      </div>

      {/* Side panel: backlinks / history / share */}
      {showSidePanel !== 'none' && (
        <div className={`px-5 py-3 border-b max-h-48 overflow-y-auto ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
          {showSidePanel === 'backlinks' && (
            <div>
              <h4 className={`text-xs font-semibold mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                反向引用 ({backlinks.length})
              </h4>
              {backlinks.length === 0 ? (
                <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>暂无其他笔记链接到此笔记</p>
              ) : backlinks.map(bl => (
                <div key={bl.linkId} className={`text-xs py-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  [[{bl.linkText}]] ← {bl.sourceTitle} ({bl.sourceNoteNo})
                </div>
              ))}
            </div>
          )}
          {showSidePanel === 'history' && (
            <div>
              <h4 className={`text-xs font-semibold mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
                版本历史 ({revisions.length})
              </h4>
              {revisions.length === 0 ? (
                <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>暂无历史版本</p>
              ) : revisions.map(rev => (
                <div key={rev.id} className={`flex items-center justify-between text-xs py-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  <span>{rev.changeSummary || rev.title} · {rev.createdAt ? new Date(rev.createdAt).toLocaleString('zh-CN') : ''}</span>
                  <button
                    onClick={() => handleRestoreRevision(rev.id)}
                    className="text-orange-500 hover:underline shrink-0 ml-2"
                  >
                    恢复
                  </button>
                </div>
              ))}
            </div>
          )}
          {showSidePanel === 'share' && (
            <div>
              <h4 className={`text-xs font-semibold mb-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>分享笔记</h4>
              <div className="flex gap-2 mb-2">
                <input
                  value={shareUserId}
                  onChange={e => setShareUserId(e.target.value)}
                  placeholder="用户 UUID"
                  className={`flex-1 text-xs px-2 py-1 rounded border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200'}`}
                />
                <select
                  value={sharePermission}
                  onChange={e => setSharePermission(e.target.value as 'view' | 'edit')}
                  className={`text-xs px-2 py-1 rounded border ${isDark ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-200'}`}
                >
                  <option value="view">只读</option>
                  <option value="edit">可编辑</option>
                </select>
                <button onClick={handleAddShare} className="text-xs px-2 py-1 rounded bg-orange-600 text-white">添加</button>
              </div>
              {shares.map(s => (
                <div key={s.id} className={`flex items-center justify-between text-xs py-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                  <span>{s.sharedWithUserId} · {s.permission === 'edit' ? '可编辑' : '只读'}</span>
                  <button onClick={() => handleRemoveShare(s.sharedWithUserId)} className="text-red-500 hover:underline">移除</button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Editor area was below description - closing duplicate removed */}

      {/* Editor */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <NoteEditorContainer
          ref={note.noteType === 'mindmap' ? mindMapEditorRef : undefined}
          key={note.noteType}
          noteId={note.id}
          noteType={note.noteType as 'rich_text' | 'markdown' | 'mindmap' | 'flowchart'}
          content={content}
          contentResetKey={contentResetKey}
          onChange={handleContentChange}
          isDark={isDark}
        />
      </div>

      {/* Footer: stats + last save hint */}
      <div className={`flex items-center justify-between px-5 py-1.5 border-t shrink-0 ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-100 bg-gray-50'}`}>
          <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
            {calcStats(note.noteType, content)}
          </span>
          <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
            {note.updatedAt ? `更新于 ${new Date(note.updatedAt).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
          </span>
        </div>
    </div>
  );
};

export default NoteEditorPanel;

/* ────── ExportDropdown 导出下拉菜单 ────── */

const ExportDropdown: React.FC<{
  noteType: string;
  title: string;
  content: unknown;
  isDark: boolean;
  mindMapRef?: React.RefObject<NoteMindMapEditorHandle | null>;
}> = ({ noteType, title, content, isDark, mindMapRef }) => {
  const [open, setOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = getExportOptions(noteType);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const handleExport = async (format: ExportFormat) => {
    setOpen(false);
    setExporting(true);
    try {
      const { exportNote } = await import('../../utils/noteExport');
      await exportNote(noteType, format, title, content, mindMapRef);
      toast.success(`已导出 ${format.toUpperCase()}`);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('导出失败，请重试');
    } finally {
      setExporting(false);
    }
  };

  if (!options.length) return null;

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(v => !v)}
        disabled={exporting}
        className={`flex items-center gap-1 px-2.5 py-1.5 text-sm rounded-lg transition-colors ${
          isDark
            ? 'text-gray-300 hover:bg-gray-700 border border-gray-600'
            : 'text-gray-600 hover:bg-gray-100 border border-gray-300'
        } ${exporting ? 'opacity-50 cursor-not-allowed' : ''}`}
        title="导出笔记"
      >
        <Download size={14} />
        <span className="hidden sm:inline">导出</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className={`absolute top-full right-0 mt-1 z-50 rounded-lg shadow-xl border py-1 min-w-[140px] ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}>
          {options.map(opt => (
            <button
              key={opt.format}
              onClick={() => handleExport(opt.format)}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                isDark ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
