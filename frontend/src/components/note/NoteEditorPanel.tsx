/**
 * NoteEditorPanel – 编辑器主面板
 *
 * 结构：
 * 顶部菜单栏（NoteMenuBar，面板命令 + 编辑器注册命令合并）
 *  → 标题行（类型徽标 / 编号 / 文件夹 / 收藏 / 标题 / 标签 / 描述）
 *  → 侧栏（反向引用 / 版本历史 / 分享）
 *  → 编辑区（编辑器容器 + 可选大纲侧栏）
 *  → 页脚（字数统计 + 更新时间）
 *
 * 同时承载：⌘S 手动保存、⌘K 命令面板、文件导入、导出、移动到文件夹等面板级命令。
 */
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Save, FileText, Code2, Brain, GitFork, Star, X, Plus, Tag } from 'lucide-react';
import toast from 'react-hot-toast';
import NoteEditorContainer from './NoteEditorContainer';
import NoteMenuBar, { type NoteMenuEntry } from './NoteMenuBar';
import NoteCommandPalette from './NoteCommandPalette';
import NoteOutlinePanel from './NoteOutlinePanel';
import type { NoteMindMapEditorHandle } from './NoteMindMapEditor';
import {
  noteApi, noteTagApi, noteTemplateApi,
  type Note, type NoteUpdate, type NoteFolder, type NoteTag,
  type NoteBacklink, type NoteRevision, type NoteShare,
} from '../../services/note';
import { getExportOptions, type ExportFormat } from '../../utils/noteExportOptions';
import { useAuth } from '../../contexts/AuthContext';
import { isNetworkError } from '../../services/client';
import { cacheFullNote, readNote } from '../../services/offline/noteCache';
import { saveOfflineEdit } from '../../services/offline/offlineQueue';
import type { OutboxPayload } from '../../services/offline/offlineDb';
import {
  MENU_GROUP_LABEL,
  MENU_GROUP_ORDER,
  mergeCommandMaps,
  type NoteCommand,
  type NoteEditorRegistry,
  type NoteMenuGroup,
  type NoteMenuGroupId,
  type NoteMenuItem,
  type NoteOutlineState,
} from '../../utils/noteCommands';

/** 各笔记类型的展示元信息 */
const TYPE_META: Record<string, { icon: React.ReactNode; label: string; badgeColor: string }> = {
  rich_text: { icon: <FileText size={14} />, label: '富文本', badgeColor: 'bg-orange-100 text-orange-600 dark:bg-orange-900/30 dark:text-orange-400' },
  markdown: { icon: <Code2 size={14} />, label: 'Markdown', badgeColor: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' },
  mindmap: { icon: <Brain size={14} />, label: '思维导图', badgeColor: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
  flowchart: { icon: <GitFork size={14} />, label: '流程图', badgeColor: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400' },
};

/** BlockNote 块的公共默认 props */
const BLOCK_BASE_PROPS = { textColor: 'default', backgroundColor: 'default', textAlignment: 'left' };

/** 编辑器注册信息的封装：附带注册时的笔记类型，便于在渲染期判定是否过期 */
interface RegistrySlot {
  type: string;
  registry: NoteEditorRegistry;
}

/** 大纲上报的封装：附带上报时的笔记类型 */
interface OutlineSlot {
  type: string;
  state: NoteOutlineState | null;
}

/**
 * 从不同笔记类型内容中统计字数/节点数
 * @param noteType 笔记类型
 * @param content 笔记内容
 * @returns 统计文案，无法统计时返回空串
 */
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

/**
 * 把 Markdown / 纯文本粗略转换为 BlockNote 块数组（供富文本导入使用）。
 * @param text 源文本
 * @returns BlockNote 可识别的块数组
 */
function textToBlocks(text: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) continue;

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        props: { ...BLOCK_BASE_PROPS, level: heading[1].length },
        content: [{ type: 'text', text: heading[2], styles: {} }],
      });
      continue;
    }
    const check = line.match(/^\s*[-*+]\s+\[( |x|X)\]\s+(.*)$/);
    if (check) {
      blocks.push({
        type: 'checkListItem',
        props: { ...BLOCK_BASE_PROPS, checked: check[1].toLowerCase() === 'x' },
        content: [{ type: 'text', text: check[2], styles: {} }],
      });
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      blocks.push({ type: 'bulletListItem', props: { ...BLOCK_BASE_PROPS }, content: [{ type: 'text', text: bullet[1], styles: {} }] });
      continue;
    }
    const num = line.match(/^\s*\d+\.\s+(.*)$/);
    if (num) {
      blocks.push({ type: 'numberedListItem', props: { ...BLOCK_BASE_PROPS }, content: [{ type: 'text', text: num[1], styles: {} }] });
      continue;
    }
    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      blocks.push({ type: 'quote', props: { ...BLOCK_BASE_PROPS }, content: [{ type: 'text', text: quote[1], styles: {} }] });
      continue;
    }
    blocks.push({ type: 'paragraph', props: { ...BLOCK_BASE_PROPS }, content: [{ type: 'text', text: line, styles: {} }] });
  }
  return blocks.length ? blocks : [{ type: 'paragraph', props: { ...BLOCK_BASE_PROPS }, content: [] }];
}

/**
 * 把命令数组转成 id → 命令 的字典
 * @param commands 命令数组
 * @returns 命令字典
 */
function toCommandMap(commands: NoteCommand[]): Record<string, NoteCommand> {
  const map: Record<string, NoteCommand> = {};
  for (const cmd of commands) map[cmd.id] = cmd;
  return map;
}

/** 快捷键帮助弹窗中展示的条目 */
const SHORTCUT_HELP: Array<{ keys: string; desc: string }> = [
  { keys: '⌘S', desc: '保存笔记' },
  { keys: '⌘K', desc: '打开命令面板' },
  { keys: '⌘N', desc: '新建笔记（列表区）' },
  { keys: '⌘⇧F', desc: '搜索笔记（列表区）' },
  { keys: '⌘Z / ⌘⇧Z', desc: '撤销 / 重做' },
  { keys: '⌘B / ⌘I / ⌘U', desc: '粗体 / 斜体 / 下划线' },
  { keys: 'Tab / Enter', desc: '思维导图：添加子节点 / 兄弟节点' },
];

interface NoteEditorPanelProps {
  note: Note;
  folders?: NoteFolder[];
  allTags?: NoteTag[];
  onNoteUpdated?: (note: Note) => void;
  onTagsChanged?: () => void;
  onDuplicateNote?: (id: string) => void;
  onDeleteNote?: (id: string) => void;
  onMoveNote?: (id: string, folderId: string | null) => void;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  isDark?: boolean;
  refreshTrigger?: number;
}

const NoteEditorPanel: React.FC<NoteEditorPanelProps> = ({
  note,
  folders = [],
  allTags = [],
  onNoteUpdated,
  onTagsChanged,
  onDuplicateNote,
  onDeleteNote,
  onMoveNote,
  onToggleFullscreen,
  isFullscreen = false,
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
  const [contentLoaded, setContentLoaded] = useState(Boolean(note.content));
  const [contentResetKey, setContentResetKey] = useState(0);
  const [description, setDescription] = useState(note.description ?? '');
  const [saving, setSaving] = useState(false);

  /* ────── 命令体系相关状态 ────── */
  /** 编辑器注册的命令与菜单（附注册时的笔记类型） */
  const [registrySlot, setRegistrySlot] = useState<RegistrySlot | null>(null);
  /** 编辑器上报的大纲数据 */
  const [outlineSlot, setOutlineSlot] = useState<OutlineSlot | null>(null);
  /** 是否显示大纲侧栏 */
  const [showOutline, setShowOutline] = useState(false);
  /** 命令面板开关 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 快捷键帮助弹窗 */
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** 移动到文件夹弹窗 */
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  /** 移动目标文件夹（空串表示根目录） */
  const [moveFolderId, setMoveFolderId] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);

  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentLoadAtRef = useRef(0);
  const contentDirtyRef = useRef(false);
  const syncedContentNoteIdRef = useRef(note.id);
  const noteIdRef = useRef(note.id);
  const noteTypeRef = useRef(note.noteType);
  noteTypeRef.current = note.noteType;
  const lastRefreshTriggerRef = useRef(refreshTrigger);
  const mindMapEditorRef = useRef<NoteMindMapEditorHandle>(null);

  const { user } = useAuth();
  const userId = user?.id ?? null;

  /**
   * 离线保存：把本次修改写入本地缓存与待同步队列。
   * 仅在网络异常时调用，缓存中不存在该笔记时返回 false（调用方回退为普通失败提示）。
   * @param payload 本次修改的字段
   * @returns 是否成功入队
   */
  const persistOffline = useCallback(async (payload: OutboxPayload): Promise<boolean> => {
    const cached = await readNote(note.id);
    if (!cached) return false;
    await saveOfflineEdit({ note: cached, payload });
    return true;
  }, [note.id]);

  // 切换笔记：先用列表缓存内容即时渲染，后台拉取最新数据
  useEffect(() => {
    syncedContentNoteIdRef.current = note.id;
    noteIdRef.current = note.id;
    contentDirtyRef.current = false;
    setTitle(note.title);
    setNoteTags(note.tags ?? []);
    setDescription(note.description ?? '');
    setShowDescField(Boolean(note.description));
    setShowTagPopover(false);
    setContent(note.content ?? null);
    setContentLoaded(Boolean(note.content));
    contentLoadAtRef.current = Date.now();

    if (contentTimerRef.current) {
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
    }

    noteApi.get(note.id).then(full => {
      if (noteIdRef.current !== note.id || contentDirtyRef.current) return;
      if (userId) void cacheFullNote(full, userId);
      setContent(full.content ?? null);
      setContentLoaded(true);
      setNoteTags(full.tags ?? []);
    }).catch(async () => {
      // 离线：回退本地缓存正文，保证断网时仍可查看与编辑
      const cached = await readNote(note.id);
      if (!cached || noteIdRef.current !== note.id || contentDirtyRef.current) return;
      setContent(cached.content ?? null);
      setContentLoaded(true);
    });
  }, [note.id, userId]);

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
      if (userId) void cacheFullNote(full, userId);
      setContent(full.content ?? null);
      setContentLoaded(true);
      setNoteTags(full.tags ?? []);
      setTitle(full.title);
      setDescription(full.description ?? '');
      setContentResetKey(k => k + 1);
      contentLoadAtRef.current = Date.now();
    }).catch(async () => {
      // 离线：刷新失败时回退本地缓存，避免编辑器被清空
      const cached = await readNote(note.id);
      if (!cached || noteIdRef.current !== note.id) return;
      setContent(cached.content ?? null);
      setContentLoaded(true);
      setNoteTags(cached.tags ?? []);
      setTitle(cached.title);
      setDescription(cached.description ?? '');
      setContentResetKey(k => k + 1);
      contentLoadAtRef.current = Date.now();
    });
  }, [refreshTrigger, note.id, userId]);

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
        if (userId) void cacheFullNote(updated, userId);
      } catch (err) {
        // 离线：标题变更入队，联网后自动回传
        if (isNetworkError(err) && await persistOffline({ title: newTitle })) {
          toast.success('已离线保存，联网后同步', { id: 'offline-save' });
        }
      }
    }, 1000);
  }, [note.id, onNoteUpdated, persistOffline, userId]);

  // Auto-save description (debounce 1s)
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDescriptionChange = useCallback((newDesc: string) => {
    setDescription(newDesc);
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = setTimeout(async () => {
      try {
        await noteApi.update(note.id, { description: newDesc } as NoteUpdate);
      } catch (err) {
        // 离线：描述变更静默入队（保持原有静默语义，避免频繁打扰）
        if (isNetworkError(err)) await persistOffline({ description: newDesc });
      }
    }, 1000);
  }, [note.id, persistOffline]);

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
      } catch (err) {
        setSaving(false);
        // 离线：正文变更入队，联网后自动回传（同一提示复用 id，避免连续输入刷屏）
        if (isNetworkError(err)
          && await persistOffline({ content: newContent as Record<string, unknown> })) {
          toast.success('已离线保存，联网后同步', { id: 'offline-save' });
        }
      }
    }, 2000);
  }, [note.id, persistOffline]);

  // Manual save
  const handleManualSave = useCallback(async () => {
    // data 在 try 外声明：离线分支需要在 catch 中复用同一份待保存载荷
    const data: NoteUpdate = {};
    if (title.trim()) data.title = title;
    if (content !== null) data.content = content as Record<string, unknown>;
    try {
      setSaving(true);
      const updated = await noteApi.update(note.id, data);
      onNoteUpdated?.(updated);
      if (userId) void cacheFullNote(updated, userId);
      toast.success('已保存');
    } catch (err) {
      // 离线：手动保存走队列，明确告知用户数据已落到本机
      if (isNetworkError(err) && await persistOffline(data)) {
        toast.success('已离线保存，联网后同步', { id: 'offline-save' });
        return;
      }
      toast.error('保存失败');
    } finally {
      setSaving(false);
    }
  }, [note.id, title, content, onNoteUpdated, persistOffline, userId]);

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

  /* ────── 面板级命令实现 ────── */

  /**
   * 导出笔记为指定格式（重型依赖按需动态加载）。
   * @param format 导出格式
   */
  const handleExport = useCallback(async (format: ExportFormat) => {
    try {
      const { exportNote } = await import('../../utils/noteExport');
      await exportNote(
        note.noteType,
        format,
        title,
        content,
        note.noteType === 'mindmap' ? mindMapEditorRef : undefined,
      );
      toast.success(`已导出 ${format.toUpperCase()}`);
    } catch (err) {
      console.error('Export failed:', err);
      toast.error('导出失败，请重试');
    }
  }, [note.noteType, title, content]);

  /**
   * 直接把一份新内容写入服务端（供导入使用），离线时入队。
   * @param next 新的内容载荷
   */
  const persistImportedContent = useCallback(async (next: unknown) => {
    const payload = { content: next as Record<string, unknown> } as NoteUpdate;
    setContent(next);
    contentDirtyRef.current = true;
    try {
      setSaving(true);
      const updated = await noteApi.update(note.id, payload);
      onNoteUpdated?.(updated);
      if (userId) void cacheFullNote(updated, userId);
      toast.success('导入完成');
    } catch (err) {
      if (isNetworkError(err) && await persistOffline(payload)) {
        toast.success('已离线导入，联网后同步', { id: 'offline-save' });
      } else {
        toast.error('导入失败');
      }
    } finally {
      setSaving(false);
    }
  }, [note.id, onNoteUpdated, persistOffline, userId]);

  /**
   * 触发导入：思维导图 / 流程图交给各自编辑器的导入命令，其余类型走隐藏文件输入。
   * @param editorCommandMap 合并后的命令字典
   */
  const handleImport = useCallback((editorCommandMap: Record<string, NoteCommand>) => {
    const delegateId = note.noteType === 'mindmap'
      ? 'mindmap.import'
      : note.noteType === 'flowchart' ? 'flowchart.import' : null;
    if (delegateId && editorCommandMap[delegateId]) {
      void editorCommandMap[delegateId].run();
      return;
    }
    const input = importInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  }, [note.noteType]);

  /**
   * 读取导入文件并替换正文。
   * @param file 用户选择的文件
   */
  const handleImportFile = useCallback(async (file: File) => {
    if (file.size > 2 * 1024 * 1024) {
      toast.error('文件过大，导入上限 2MB');
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      toast.error('文件读取失败');
      return;
    }
    if (note.noteType === 'markdown') {
      await persistImportedContent({ text });
    } else if (note.noteType === 'rich_text') {
      await persistImportedContent({ blocks: textToBlocks(text) });
    }
    contentLoadAtRef.current = Date.now();
    setContentResetKey(k => k + 1);
  }, [note.noteType, persistImportedContent]);

  /** 执行移动到文件夹 */
  const handleConfirmMove = useCallback(() => {
    setShowMoveDialog(false);
    onMoveNote?.(note.id, moveFolderId || null);
  }, [note.id, moveFolderId, onMoveNote]);

  /* ────── 命令与菜单装配 ────── */

  /** 编辑器上报的注册信息（按笔记类型过滤掉过期的注册） */
  const registry = registrySlot && registrySlot.type === note.noteType ? registrySlot.registry : null;
  /** 大纲状态（按笔记类型过滤） */
  const outlineState = outlineSlot && outlineSlot.type === note.noteType ? outlineSlot.state : null;
  /** 当前笔记是否有大纲能力 */
  const outlineAvailable = Boolean(outlineState);

  /** 面板级命令（文件 / 视图 / 帮助） */
  const panelCommands = useMemo<NoteCommand[]>(() => {
    const exportOptions = getExportOptions(note.noteType);
    const commands: NoteCommand[] = [
      { id: 'file.save', label: '保存笔记', shortcut: 'Mod+S', keywords: 'save 保存', run: handleManualSave },
      {
        id: 'file.import',
        label: '导入文件…',
        keywords: 'import 导入 打开',
        run: () => handleImport(currentCommandMapRef.current),
      },
      ...exportOptions.map(opt => ({
        id: `file.export.${opt.format}`,
        label: opt.label,
        keywords: `export 导出 ${opt.format}`,
        run: () => handleExport(opt.format),
      })),
      { id: 'file.saveAsTemplate', label: '另存为模板…', keywords: 'template 模板', run: handleSaveAsTemplate },
      {
        id: 'file.duplicate',
        label: '复制笔记',
        keywords: 'duplicate copy 复制',
        run: () => onDuplicateNote?.(note.id),
        isEnabled: () => Boolean(onDuplicateNote),
      },
      {
        id: 'file.move',
        label: '移动到文件夹…',
        keywords: 'move folder 移动 文件夹',
        run: () => { setMoveFolderId(note.folderId ?? ''); setShowMoveDialog(true); },
        isEnabled: () => Boolean(onMoveNote),
      },
      {
        id: 'file.delete',
        label: '删除笔记',
        keywords: 'delete 删除 回收站',
        danger: true,
        run: () => onDeleteNote?.(note.id),
        isEnabled: () => Boolean(onDeleteNote),
      },
      { id: 'view.palette', label: '命令面板', shortcut: 'Mod+K', keywords: 'command palette 命令', run: () => setPaletteOpen(true) },
      { id: 'view.outline', label: '显示大纲', keywords: 'outline toc 大纲 目录', run: () => setShowOutline(v => !v), isEnabled: () => outlineAvailable, isChecked: () => showOutline },
      { id: 'view.fullscreen', label: isFullscreen ? '退出全屏' : '全屏编辑', keywords: 'fullscreen 全屏', run: () => onToggleFullscreen?.(), isEnabled: () => Boolean(onToggleFullscreen), isChecked: () => isFullscreen },
      { id: 'view.backlinks', label: '反向引用', keywords: 'backlink 反向引用 链接', run: () => setShowSidePanel(v => (v === 'backlinks' ? 'none' : 'backlinks')), isChecked: () => showSidePanel === 'backlinks' },
      { id: 'view.history', label: '版本历史', keywords: 'history revision 版本 历史', run: () => { void loadRevisions(); setShowSidePanel(v => (v === 'history' ? 'none' : 'history')); }, isChecked: () => showSidePanel === 'history' },
      { id: 'view.share', label: '分享笔记', keywords: 'share 分享', run: () => { void loadShares(); setShowSidePanel(v => (v === 'share' ? 'none' : 'share')); }, isChecked: () => showSidePanel === 'share' },
      { id: 'view.tags', label: '管理标签', keywords: 'tag 标签', run: () => setShowTagPopover(v => !v) },
      { id: 'help.shortcuts', label: '快捷键说明', keywords: 'shortcut help 快捷键 帮助', run: () => setShowShortcuts(true) },
      { id: 'help.about', label: '关于笔记编辑器', keywords: 'about 关于', run: () => toast(`AIDriveNote · ${TYPE_META[note.noteType]?.label ?? note.noteType} 编辑器\n按 ⌘K 可搜索全部命令`, { icon: 'ℹ️' }) },
    ];
    return commands;
  }, [
    note.noteType, note.id, note.folderId, handleManualSave, handleImport, handleExport,
    handleSaveAsTemplate, onDuplicateNote, onDeleteNote, onMoveNote, onToggleFullscreen,
    outlineAvailable, showOutline, isFullscreen, showSidePanel, loadRevisions, loadShares,
  ]);

  /** 面板命令字典（编辑器命令的合并基准） */
  const panelCommandMap = useMemo(() => toCommandMap(panelCommands), [panelCommands]);

  /** 合并后的命令字典：面板优先 */
  const commandMap = useMemo(
    () => mergeCommandMaps(registry ? toCommandMap(registry.commands) : undefined, panelCommandMap),
    [registry, panelCommandMap],
  );

  /** 供命令闭包读取最新命令字典（避免循环依赖） */
  const currentCommandMapRef = useRef<Record<string, NoteCommand>>(commandMap);
  currentCommandMapRef.current = commandMap;

  /** 面板菜单组 */
  const panelGroups = useMemo<NoteMenuGroup[]>(() => {
    const exportItems: NoteMenuItem[] = getExportOptions(note.noteType)
      .map(opt => ({ commandId: `file.export.${opt.format}` }));

    return [
      {
        id: 'file',
        items: [
          { commandId: 'file.save' },
          { commandId: 'file.import', separatorBefore: true },
          { children: exportItems, labelOverride: '导出为…' },
          { commandId: 'file.saveAsTemplate', separatorBefore: true },
          { commandId: 'file.duplicate' },
          { commandId: 'file.move' },
          { commandId: 'file.delete', separatorBefore: true },
        ],
      },
      {
        id: 'view',
        items: [
          ...(outlineAvailable ? [{ commandId: 'view.outline' }] : []),
          { commandId: 'view.fullscreen' },
          { commandId: 'view.palette' },
          { commandId: 'view.backlinks', separatorBefore: true },
          { commandId: 'view.history' },
          { commandId: 'view.share' },
          { commandId: 'view.tags' },
        ],
      },
      {
        id: 'help',
        items: [
          { commandId: 'help.shortcuts' },
          { commandId: 'help.about' },
        ],
      },
    ];
  }, [note.noteType, outlineAvailable]);

  /** 最终菜单：面板组与编辑器组按 id 合并 */
  const menus = useMemo<NoteMenuEntry[]>(() => {
    const byId = new Map<NoteMenuGroupId, NoteMenuItem[]>();
    for (const group of panelGroups) byId.set(group.id, [...group.items]);
    for (const group of (registry?.groups ?? [])) {
      const existing = byId.get(group.id) ?? [];
      const appended = group.items.map((item, index) =>
        (index === 0 && existing.length > 0 ? { ...item, separatorBefore: true } : item));
      byId.set(group.id, [...existing, ...appended]);
    }
    return MENU_GROUP_ORDER
      .map(id => ({
        group: { id, label: MENU_GROUP_LABEL[id], items: byId.get(id) ?? [] } as NoteMenuGroup,
        commands: commandMap,
      }))
      .filter(entry => entry.group.items.length > 0);
  }, [panelGroups, registry, commandMap]);

  /** 命令面板可选命令：面板命令 + 编辑器全部命令（去重） */
  const paletteCommands = useMemo<NoteCommand[]>(() => {
    const seen = new Set<string>();
    const list: NoteCommand[] = [];
    for (const cmd of [...panelCommands, ...(registry?.commands ?? [])]) {
      if (seen.has(cmd.id)) continue;
      seen.add(cmd.id);
      list.push(cmd);
    }
    return list;
  }, [panelCommands, registry]);

  /** 编辑器的注册回调（稳定引用，通过 ref 读取当前笔记类型） */
  const handleRegistryChange = useCallback((next: NoteEditorRegistry) => {
    setRegistrySlot({ type: noteTypeRef.current, registry: next });
  }, []);

  /** 编辑器的大纲上报回调（稳定引用） */
  const handleOutlineChange = useCallback((next: NoteOutlineState | null) => {
    setOutlineSlot({ type: noteTypeRef.current, state: next });
  }, []);

  /** 命令面板关闭 */
  const handlePaletteClose = useCallback(() => setPaletteOpen(false), []);

  // Cleanup timers
  useEffect(() => {
    return () => {
      if (titleTimerRef.current) clearTimeout(titleTimerRef.current);
      if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    };
  }, []);

  // Ctrl+S 保存 / Ctrl+K 命令面板
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleManualSave();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(v => !v);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleManualSave]);

  const typeMeta = TYPE_META[note.noteType] || TYPE_META.rich_text;

  // content state 在 useEffect 中更新会滞后一帧；切换笔记时先用 prop 缓存
  const contentForEditor = syncedContentNoteIdRef.current !== note.id
    ? (note.content ?? null)
    : content;

  /** 大纲侧栏是否真正可见 */
  const outlineVisible = showOutline && Boolean(outlineState);

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* 菜单栏 + 保存 */}
      <div className={`flex items-center justify-between gap-2 px-3 py-1.5 border-b shrink-0 ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <NoteMenuBar menus={menus} isDark={isDark} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saving && (
            <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>保存中...</span>
          )}
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className={`hidden sm:inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md border transition-colors ${
              isDark
                ? 'border-gray-600 text-gray-400 hover:bg-gray-700'
                : 'border-gray-200 text-gray-500 hover:bg-gray-100'
            }`}
            title="打开命令面板 (⌘K)"
          >
            ⌘K 命令
          </button>
          <button
            type="button"
            onClick={handleManualSave}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg transition-colors bg-orange-600 text-white hover:bg-orange-700"
          >
            <Save size={14} /> 保存
          </button>
        </div>
      </div>

      {/* Title row — compact */}
      <div className={`px-4 py-2 border-b ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-100 bg-white'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${typeMeta.badgeColor}`}>
            {typeMeta.icon} {typeMeta.label}
          </span>
          <span className={`text-xs shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {note.noteNo}
          </span>
          {note.folderId && folders.length > 0 && (() => {
            const folder = folders.find(f => f.id === note.folderId);
            return folder ? (
              <span className={`text-xs flex items-center gap-1 shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" /></svg>
                {folder.name}
              </span>
            ) : null;
          })()}
          {note.isFavorite && (
            <Star size={14} className="text-amber-400 fill-amber-400 shrink-0" />
          )}
          <input
            value={title}
            onChange={e => handleTitleChange(e.target.value)}
            placeholder="输入标题..."
            className={`flex-1 min-w-0 text-lg font-semibold outline-none bg-transparent ${
              isDark ? 'text-white placeholder-gray-600' : 'text-gray-900 placeholder-gray-300'
            }`}
          />
          {/* Inline tag chips (compact) */}
          <div className="hidden sm:flex items-center gap-1 shrink-0 max-w-[30%] overflow-hidden">
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
        <div className={`px-5 py-3 border-b max-h-48 overflow-y-auto shrink-0 ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-200 bg-gray-50'}`}>
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

      {/* Editor + outline */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        <div className="flex-1 min-w-0 min-h-0 overflow-hidden">
          {!contentLoaded && content == null ? (
            <div className={`flex flex-col items-center justify-center h-full ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600 mb-2" />
              <span className="text-xs">加载内容中…</span>
            </div>
          ) : (
            <NoteEditorContainer
              ref={note.noteType === 'mindmap' ? mindMapEditorRef : undefined}
              key={note.id}
              noteId={note.id}
              noteType={note.noteType as 'rich_text' | 'markdown' | 'mindmap' | 'flowchart'}
              content={contentForEditor}
              contentResetKey={contentResetKey}
              onChange={handleContentChange}
              isDark={isDark}
              onRegistryChange={handleRegistryChange}
              onOutlineChange={handleOutlineChange}
            />
          )}
        </div>
        {outlineVisible && outlineState && (
          <NoteOutlinePanel
            items={outlineState.items}
            activeId={outlineState.activeId}
            onSelect={outlineState.onSelect}
            onClose={() => setShowOutline(false)}
            isDark={isDark}
          />
        )}
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

      {/* 隐藏的导入文件输入 */}
      <input
        ref={importInputRef}
        type="file"
        accept={note.noteType === 'markdown' || note.noteType === 'rich_text'
          ? '.md,.markdown,.txt,text/plain,text/markdown'
          : '.json,.smm,.xml,.drawio'}
        className="hidden"
        onChange={e => {
          const file = e.target.files?.[0];
          if (file) void handleImportFile(file);
        }}
      />

      {/* 命令面板 */}
      <NoteCommandPalette
        open={paletteOpen}
        onClose={handlePaletteClose}
        commands={paletteCommands}
        isDark={isDark}
      />

      {/* 移动到文件夹弹窗 */}
      {showMoveDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowMoveDialog(false)}>
          <div
            className={`w-80 rounded-xl border shadow-2xl p-4 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
            onClick={e => e.stopPropagation()}
          >
            <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>移动到文件夹</h3>
            <select
              value={moveFolderId}
              onChange={e => setMoveFolderId(e.target.value)}
              className={`w-full text-sm px-2 py-1.5 rounded-lg border outline-none ${isDark ? 'bg-gray-900 border-gray-600 text-gray-200' : 'bg-white border-gray-300 text-gray-700'}`}
            >
              <option value="">根目录</option>
              {folders.map(f => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
            <div className="flex justify-end gap-2 mt-4">
              <button
                type="button"
                onClick={() => setShowMoveDialog(false)}
                className={`px-3 py-1.5 text-xs rounded-lg border ${isDark ? 'border-gray-600 text-gray-300' : 'border-gray-300 text-gray-600'}`}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleConfirmMove}
                className="px-3 py-1.5 text-xs rounded-lg bg-orange-600 text-white hover:bg-orange-700"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 快捷键说明 */}
      {showShortcuts && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowShortcuts(false)}>
          <div
            className={`w-96 rounded-xl border shadow-2xl p-4 ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}
            onClick={e => e.stopPropagation()}
          >
            <h3 className={`text-sm font-semibold mb-3 ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>快捷键说明</h3>
            <div className="space-y-1.5">
              {SHORTCUT_HELP.map(item => (
                <div key={item.keys} className="flex items-center justify-between text-xs">
                  <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>{item.desc}</span>
                  <span className={`tabular-nums px-1.5 py-0.5 rounded border ${isDark ? 'border-gray-600 text-gray-300' : 'border-gray-200 text-gray-500'}`}>
                    {item.keys}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-end mt-4">
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                className="px-3 py-1.5 text-xs rounded-lg bg-orange-600 text-white hover:bg-orange-700"
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default NoteEditorPanel;