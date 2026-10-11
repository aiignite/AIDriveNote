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
import { Save, FileText, Code2, Brain, GitFork, Star, X, Plus, Tag, ChevronLeft, AlertCircle, Sparkles, Loader2, Check, Lock } from 'lucide-react';
import toast from 'react-hot-toast';
import NoteEditorContainer from './NoteEditorContainer';
import NoteMenuBar, { type NoteMenuEntry } from './NoteMenuBar';
import NoteCommandPalette from './NoteCommandPalette';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import NoteOutlinePanel from './NoteOutlinePanel';
import NoteEmailDialog from './NoteEmailDialog';
import PasswordDialog from './PasswordDialog';
import type { NoteMindMapEditorHandle } from './NoteMindMapEditor';
import {
  noteApi, noteTagApi, noteTemplateApi, noteTitleApi, noteLockApi,
  getUnlockToken, setUnlockToken,
  type Note, type NoteUpdate, type NoteFolder, type NoteTag,
  type NoteBacklink, type NoteRevision, type NoteShare, type LockScope,
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
  { keys: '⌘P', desc: '快速跳转到笔记' },
  { keys: '⌘N', desc: '新建笔记（列表区）' },
  { keys: '⌘⇧F', desc: '搜索笔记（列表区）' },
  { keys: '⌘J', desc: '打开 AI 助手' },
  { keys: 'Esc', desc: '关闭 AI 助手（焦点不在输入框时）' },
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
  /** 移动端返回列表：传入后在顶部菜单栏显示返回按钮 */
  onBack?: () => void;
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
  onBack,
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
  /**
   * 当前笔记的保护域（加密来源）。null 表示未加密。
   * 即便已解锁，仍需保留该信息以便后续保存请求带上 X-Note-Unlock 票据。
   */
  const [lockTarget, setLockTarget] = useState<{ scope: LockScope; id: string } | null>(
    note.lockedScope ? { scope: note.lockedScope as LockScope, id: note.lockedId ?? note.id } : null,
  );
  /** 是否处于锁定态（未持有有效票据）；锁定时渲染解锁页而非编辑器 */
  const [locked, setLocked] = useState<boolean>(() => {
    if (!note.lockedScope) return false;
    return !getUnlockToken(note.lockedScope as LockScope, note.lockedId ?? note.id);
  });
  /** lockTarget 的 ref 镜像，供异步回调读取最新值 */
  const lockTargetRef = useRef(lockTarget);
  lockTargetRef.current = lockTarget;
  /** 是否显示解锁对话框 */
  const [showUnlockDialog, setShowUnlockDialog] = useState(false);

  /**
   * 取当前笔记应携带的解锁票据。
   * 未加密（lockTarget 为空）或尚未解锁时返回 null。
   */
  const currentUnlockToken = useCallback((): string | null => {
    const info = lockTargetRef.current;
    if (!info) return null;
    return getUnlockToken(info.scope, info.id);
  }, []);
  /**
   * 正文保存失败时的待保存载荷。
   * 非 null 表示「有内容没能存进服务端」，标题栏会显示可重试的红色提示，
   * 切换笔记 / 关闭页面前会尝试补存，避免用户白写内容。
   */
  const [saveError, setSaveError] = useState<OutboxPayload | null>(null);
  /** saveError 的 ref 镜像，供 beforeunload 等非 React 回调读取最新值 */
  const saveErrorRef = useRef<OutboxPayload | null>(null);
  saveErrorRef.current = saveError;

  /* ────── 命令体系相关状态 ────── */
  /** 编辑器注册的命令与菜单（附注册时的笔记类型） */
  const [registrySlot, setRegistrySlot] = useState<RegistrySlot | null>(null);
  /** 编辑器上报的大纲数据 */
  const [outlineSlot, setOutlineSlot] = useState<OutlineSlot | null>(null);
  /** 是否显示大纲侧栏 */
  const [showOutline, setShowOutline] = useState(false);
  /** 是否打开录音转写面板（仅富文本） */
  /** 命令面板开关 */
  const [paletteOpen, setPaletteOpen] = useState(false);
  /** 快捷键帮助弹窗 */
  const [showShortcuts, setShowShortcuts] = useState(false);
  /** 移动到文件夹弹窗 */
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  /** 「发送到邮箱」弹窗（文件菜单触发） */
  const [showEmailDialog, setShowEmailDialog] = useState(false);
  /** 移动目标文件夹（空串表示根目录） */
  const [moveFolderId, setMoveFolderId] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  /** 两个模态弹窗的容器，用于焦点陷阱 */
  const shortcutsDialogRef = useRef<HTMLDivElement>(null);
  const moveDialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(shortcutsDialogRef, showShortcuts);
  useFocusTrap(moveDialogRef, showMoveDialog);

  const titleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contentTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 防抖期间待保存的正文；切换笔记 / 关闭页面前据此补存，避免静默丢失 */
  const pendingContentRef = useRef<OutboxPayload | null>(null);
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
    // 加密文档不支持离线暂存：本地不缓存明文，队列也无法携带解锁票据回传，
    // 因此直接返回失败，由调用方提示「保存失败」并让用户联网后重试。
    if (lockTargetRef.current) return false;
    const cached = await readNote(note.id);
    if (!cached) return false;
    await saveOfflineEdit({ note: cached, payload });
    return true;
  }, [note.id]);

  /**
   * 依据服务端返回同步锁定状态（保护域 + 是否锁定）。
   * 已解锁时 lockedScope/lockedId 仍会返回，因此保存请求能继续带上票据。
   * @param full 服务端返回的笔记
   * @returns 是否处于锁定态
   */
  const syncLockState = useCallback((full: Note): boolean => {
    const target = full.lockedScope
      ? { scope: full.lockedScope as LockScope, id: full.lockedId ?? full.id }
      : null;
    setLockTarget(target);
    const isLocked = Boolean(full.isLocked);
    setLocked(isLocked);
    return isLocked;
  }, []);

  // 切换笔记：先用列表缓存内容即时渲染，后台拉取最新数据
  useEffect(() => {
    const prevId = noteIdRef.current;
    const switchingAway = prevId !== note.id;

    // 离开旧笔记前，若防抖保存还没触发，先补存一次。
    // 此前直接 clearTimeout 会让 2 秒内输入的内容随笔记切换而丢失。
    if (switchingAway && contentTimerRef.current) {
      const pending = pendingContentRef.current;
      clearTimeout(contentTimerRef.current);
      contentTimerRef.current = null;
      if (pending) void flushContentSave(pending);
    }

    syncedContentNoteIdRef.current = note.id;
    noteIdRef.current = note.id;
    contentDirtyRef.current = false;
    pendingContentRef.current = null;
    setSaveError(null);
    setTitle(note.title);
    setNoteTags(note.tags ?? []);
    setDescription(note.description ?? '');
    setShowDescField(Boolean(note.description));
    setShowTagPopover(false);
    setContent(note.content ?? null);
    setContentLoaded(Boolean(note.content));
    contentLoadAtRef.current = Date.now();

    noteApi.get(note.id, currentUnlockToken()).then(full => {
      if (noteIdRef.current !== note.id || contentDirtyRef.current) return;
      // 锁定态：不写入正文、不落缓存，交由解锁页处理
      if (syncLockState(full)) {
        setContent(null);
        return;
      }
      // 加密文档的明文由 noteCache 统一剥离，不会落盘
      if (userId) void cacheFullNote(full, userId);
      setContent(full.content ?? null);
      setContentLoaded(true);
      setNoteTags(full.tags ?? []);
    }).catch(async () => {
      // 离线：加密文档本地无明文可回退，保持锁定态并提示解锁
      if (lockTargetRef.current) {
        if (noteIdRef.current === note.id) { setLocked(true); setContentLoaded(false); }
        return;
      }
      // 离线：回退本地缓存正文，保证断网时仍可查看与编辑
      const cached = await readNote(note.id);
      if (!cached || noteIdRef.current !== note.id || contentDirtyRef.current) return;
      setContent(cached.content ?? null);
      setContentLoaded(true);
    });
  }, [note.id, userId, currentUnlockToken, syncLockState]);

  // 离开页面前拦截：有未落库的内容时让浏览器弹确认框。
  // 防抖保存最长有 2s 延迟，直接关标签页/刷新会让这段输入无处可寻。
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!contentDirtyRef.current && !saveErrorRef.current) return;
      e.preventDefault();
      // 兼容旧浏览器；现代浏览器会显示自定义文案
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

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
    noteApi.get(note.id, currentUnlockToken()).then(full => {
      if (noteIdRef.current !== note.id) return;
      if (syncLockState(full)) {
        setContent(null);
        setContentResetKey(k => k + 1);
        return;
      }
      if (userId) void cacheFullNote(full, userId);
      setContent(full.content ?? null);
      setContentLoaded(true);
      setNoteTags(full.tags ?? []);
      setTitle(full.title);
      setDescription(full.description ?? '');
      setContentResetKey(k => k + 1);
      contentLoadAtRef.current = Date.now();
    }).catch(async () => {
      // 离线：加密文档刷新失败时同样保持锁定态，避免空白编辑器
      if (lockTargetRef.current) {
        if (noteIdRef.current === note.id) { setLocked(true); setContentLoaded(false); }
        return;
      }
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
  }, [refreshTrigger, note.id, userId, currentUnlockToken, syncLockState]);

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
        const updated = await noteApi.update(note.id, { title: newTitle } as NoteUpdate, currentUnlockToken());
        onNoteUpdated?.(updated);
        if (userId && !lockTargetRef.current) void cacheFullNote(updated, userId);
      } catch (err) {
        // 离线：标题变更入队，联网后自动回传
        if (isNetworkError(err) && await persistOffline({ title: newTitle })) {
          toast.success('已离线保存，联网后同步', { id: 'offline-save' });
        }
      }
    }, 1000);
  }, [note.id, onNoteUpdated, persistOffline, userId, currentUnlockToken]);

  /* ── AI 标题 ──────────────────────────────────────
   * 与自动推导分工：后端在保存内容时会用「中心主题 / 首行 / 首节点」填充占位标题；
   * 这里处理正文没有显式标题的情况，由模型概括一个。生成结果先落在输入框里由用户确认，
   * 不直接静默写入。 */

  /** AI 正在生成标题 */
  const [aiTitleLoading, setAiTitleLoading] = useState(false);
  /** AI 标题建议（待用户确认） */
  const [aiTitleSuggestion, setAiTitleSuggestion] = useState<string | null>(null);

  // 切换笔记时清掉上一篇的建议，避免误应用到新笔记
  useEffect(() => {
    setAiTitleSuggestion(null);
    setAiTitleLoading(false);
  }, [note.id]);

  /** 请求 AI 生成标题建议（不写入，仅供确认） */
  const handleGenerateAiTitle = useCallback(async () => {
    if (aiTitleLoading) return;
    setAiTitleLoading(true);
    try {
      const result = await noteTitleApi.generate(note.id);
      if (!result.title) {
        toast.error('未能生成标题，请确认笔记内容不为空');
        return;
      }
      setAiTitleSuggestion(result.title);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 标题生成失败');
    } finally {
      setAiTitleLoading(false);
    }
  }, [note.id, aiTitleLoading]);

  /** 从内容推导标题（不调模型，即时返回） */
  const handleDeriveTitle = useCallback(async () => {
    try {
      const result = await noteTitleApi.derive(note.id);
      if (!result.title) {
        toast.error('内容中没有可用的标题信息');
        return;
      }
      setAiTitleSuggestion(result.title);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '标题提取失败');
    }
  }, [note.id]);

  /** 采纳建议：填入输入框并沿用既有的自动保存流程 */
  const applyAiTitle = useCallback(() => {
    if (!aiTitleSuggestion) return;
    handleTitleChange(aiTitleSuggestion);
    setAiTitleSuggestion(null);
    toast.success('标题已更新');
  }, [aiTitleSuggestion, handleTitleChange]);

  // Auto-save description (debounce 1s)
  const descTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleDescriptionChange = useCallback((newDesc: string) => {
    setDescription(newDesc);
    if (descTimerRef.current) clearTimeout(descTimerRef.current);
    descTimerRef.current = setTimeout(async () => {
      try {
        await noteApi.update(note.id, { description: newDesc } as NoteUpdate, currentUnlockToken());
      } catch (err) {
        // 离线：描述变更静默入队（保持原有静默语义，避免频繁打扰）
        if (isNetworkError(err)) await persistOffline({ description: newDesc });
      }
    }, 1000);
  }, [note.id, persistOffline, currentUnlockToken]);

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

  /**
   * 把正文真正写入服务端（自动保存与手动重试共用）。
   *
   * 失败分两类，此前只有网络异常被处理、其余错误被静默吞掉，导致用户
   * 以为已保存、实际内容丢失：
   * - 网络异常且能入离线队列 → 视为已保存，提示联网后自动同步；
   * - 网络异常但缓存里没有这篇笔记，或非网络异常（500 / 401 / 校验失败等）
   *   → 记录 saveError，标题栏显示红色「保存失败，点击重试」。
   *
   * @param payload 正文载荷
   */
  const flushContentSave = useCallback(async (payload: OutboxPayload) => {
    const targetId = noteIdRef.current;
    try {
      setSaving(true);
      await noteApi.update(targetId, { content: payload.content as Record<string, unknown> } as NoteUpdate, currentUnlockToken());
      setSaving(false);
      setSaveError(null);
      if (targetId === noteIdRef.current) contentDirtyRef.current = false;
    } catch (err) {
      setSaving(false);
      // 离线：正文变更入队，联网后自动回传（同一提示复用 id，避免连续输入刷屏）
      if (isNetworkError(err) && await persistOffline(payload)) {
        toast.success('已离线保存，联网后同步', { id: 'offline-save' });
        if (targetId === noteIdRef.current) contentDirtyRef.current = false;
        return;
      }
      // 其余失败一律留痕并提示，绝不静默丢弃用户内容
      if (targetId === noteIdRef.current) setSaveError(payload);
      toast.error('保存失败，内容未保存', { id: 'save-failed' });
    }
  }, [persistOffline, currentUnlockToken]);

  // Auto-save content (debounce 2s) — AI 刷新后 1.5s 内忽略编辑器初始化 onChange
  const handleContentChange = useCallback((newContent: unknown) => {
    if (Date.now() - contentLoadAtRef.current < 1500) return;
    contentDirtyRef.current = true;
    setContent(newContent);
    setSaveError(null); // 新一轮编辑清除上次的失败提示
    const payload: OutboxPayload = { content: newContent as Record<string, unknown> };
    pendingContentRef.current = payload;
    if (contentTimerRef.current) clearTimeout(contentTimerRef.current);
    contentTimerRef.current = setTimeout(() => {
      pendingContentRef.current = null;
      void flushContentSave(payload);
    }, 2000);
  }, [flushContentSave]);

  // Manual save
  const handleManualSave = useCallback(async () => {
    // data 在 try 外声明：离线分支需要在 catch 中复用同一份待保存载荷
    const data: NoteUpdate = {};
    if (title.trim()) data.title = title;
    if (content !== null) data.content = content as Record<string, unknown>;
    try {
      setSaving(true);
      const updated = await noteApi.update(note.id, data, currentUnlockToken());
      onNoteUpdated?.(updated);
      if (userId && !lockTargetRef.current) void cacheFullNote(updated, userId);
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
  }, [note.id, title, content, onNoteUpdated, persistOffline, userId, currentUnlockToken]);

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
      const updated = await noteApi.update(note.id, payload, currentUnlockToken());
      onNoteUpdated?.(updated);
      if (userId && !lockTargetRef.current) void cacheFullNote(updated, userId);
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
  }, [note.id, onNoteUpdated, persistOffline, userId, currentUnlockToken]);

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

  /**
   * 提交解锁密码：校验通过后落地票据并载入明文正文。
   * 异常由 PasswordDialog 内部展示，对话框保持打开。
   * @param password 用户输入的密码
   */
  const handleUnlockSubmit = useCallback(async (password: string) => {
    const res = await noteLockApi.unlock(note.id, password);
    const scope = (res.note.lockedScope ?? lockTargetRef.current?.scope ?? 'note') as LockScope;
    const id = res.note.lockedId ?? lockTargetRef.current?.id ?? note.id;
    setUnlockToken(scope, id, res.unlockToken ?? null);
    setLockTarget({ scope, id });
    setLocked(false);
    setTitle(res.note.title);
    setNoteTags(res.note.tags ?? []);
    setDescription(res.note.description ?? '');
    setContent(res.note.content ?? null);
    setContentLoaded(true);
    setContentResetKey(k => k + 1);
    contentLoadAtRef.current = Date.now();
    onNoteUpdated?.(res.note);
    toast.success('已解锁');
  }, [note.id, onNoteUpdated]);

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
        id: 'file.sendEmail',
        label: '发送到邮箱…',
        keywords: 'email mail 邮件 发信 发送',
        run: () => setShowEmailDialog(true),
      },
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

  /**
   * 编辑器的注册回调（稳定引用，通过 ref 读取当前笔记类型）。
   * 兜底防环：registry 引用未变时返回原 state，避免「上报 → 父组件重渲染 →
   * 子编辑器 registry 重算 → 再上报」形成无限更新循环导致页面崩溃。
   */
  const handleRegistryChange = useCallback((next: NoteEditorRegistry) => {
    const type = noteTypeRef.current;
    setRegistrySlot(prev => (
      prev && prev.type === type && prev.registry === next ? prev : { type, registry: next }
    ));
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
      if (contentTimerRef.current) {
        // 关闭编辑器（如移动端返回列表、全屏退出）时若仍有防抖待存内容，立即补存，
        // 否则这 2 秒内的输入会随组件卸载一起消失
        const pending = pendingContentRef.current;
        clearTimeout(contentTimerRef.current);
        contentTimerRef.current = null;
        if (pending) void flushContentSave(pending);
      }
    };
  }, [flushContentSave]);

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

  // 锁定态：不渲染编辑器，只展示解锁页（标题可见、正文不可见）
  if (locked) {
    const lockedByFolder = lockTarget?.scope === 'folder';
    return (
      <div className={`h-full flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
        {/* 顶部返回条（移动端用于回到列表） */}
        <div className={`flex items-center gap-2 px-3 py-1.5 border-b shrink-0 safe-x ${
          isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'
        }`}>
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className={`shrink-0 p-1 -ml-1 rounded-md transition-colors ${
                isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'
              }`}
              title="返回列表"
            >
              <ChevronLeft size={18} />
            </button>
          ) : null}
          <span className={`text-sm truncate ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>{note.title}</span>
        </div>

        <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-orange-500/10 to-amber-500/10 flex items-center justify-center mb-4">
            <Lock size={28} className="text-orange-500" />
          </div>
          <h3 className={`text-lg font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
            该文档已加密
          </h3>
          <p className={`text-sm mb-6 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {lockedByFolder ? '此文档位于加密文件夹中，输入密码后即可查看内容' : '输入密码后即可查看内容'}
          </p>
          <button
            type="button"
            onClick={() => setShowUnlockDialog(true)}
            className="px-5 py-2 text-sm rounded-lg bg-orange-600 text-white hover:bg-orange-700 transition-colors"
          >
            解锁查看
          </button>
        </div>

        <PasswordDialog
          open={showUnlockDialog}
          mode="unlock"
          title="解锁文档"
          isDark={isDark}
          onClose={() => setShowUnlockDialog(false)}
          onSubmit={handleUnlockSubmit}
        />
      </div>
    );
  }

  // content state 在 useEffect 中更新会滞后一帧；切换笔记时先用 prop 缓存
  const contentForEditor = syncedContentNoteIdRef.current !== note.id
    ? (note.content ?? null)
    : content;

  /** 大纲侧栏是否真正可见 */
  const outlineVisible = showOutline && Boolean(outlineState);

  return (
    <div className={`h-full flex flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-50'}`}>
      {/* 菜单栏 + 保存 */}
      <div className={`flex items-center justify-between gap-2 px-3 py-1.5 border-b shrink-0 safe-x ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
        <div className="flex items-center gap-2 min-w-0">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className={`shrink-0 p-1 -ml-1 rounded-md transition-colors ${isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100'}`}
              title="返回列表"
            >
              <ChevronLeft size={18} />
            </button>
          ) : null}
          <NoteMenuBar menus={menus} isDark={isDark} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {saveError && (
            <button
              type="button"
              onClick={() => void flushContentSave(saveError)}
              className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded transition-colors ${
                isDark
                  ? 'text-red-400 hover:bg-red-950/40'
                  : 'text-red-600 hover:bg-red-50'
              }`}
              title="正文未能保存，点击重试"
            >
              <AlertCircle size={12} /> 保存失败，点击重试
            </button>
          )}
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
          <span className={`text-xs shrink-0 hidden sm:inline ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {note.noteNo}
          </span>
          {note.folderId && folders.length > 0 && (() => {
            const folder = folders.find(f => f.id === note.folderId);
            return folder ? (
              <span className={`text-xs hidden sm:flex items-center gap-1 shrink-0 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
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
          {/* AI 标题：生成建议 → 用户确认后才写入 */}
          <div className="shrink-0 flex items-center gap-1">
            {aiTitleSuggestion ? (
              <>
                <span className={`hidden md:inline text-xs max-w-[180px] truncate ${
                  isDark ? 'text-gray-400' : 'text-gray-500'
                }`} title={aiTitleSuggestion}>
                  {aiTitleSuggestion}
                </span>
                <button
                  type="button"
                  onClick={applyAiTitle}
                  title="采纳该标题"
                  className="p-1 rounded-md bg-orange-600 text-white hover:bg-orange-700 transition-colors"
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => setAiTitleSuggestion(null)}
                  title="忽略"
                  className={`p-1 rounded-md transition-colors ${
                    isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  <X size={14} />
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => void handleDeriveTitle()}
                  title="从内容提取标题（中心主题 / 首行 / 首个节点）"
                  className={`p-1 rounded-md transition-colors ${
                    isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  <FileText size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => void handleGenerateAiTitle()}
                  disabled={aiTitleLoading}
                  title="AI 生成标题"
                  className={`p-1 rounded-md transition-colors disabled:opacity-50 ${
                    isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                  }`}
                >
                  {aiTitleLoading ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
                </button>
              </>
            )}
          </div>
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
      <div className={`flex items-center justify-between px-5 py-1.5 border-t shrink-0 safe-bottom safe-x ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-100 bg-gray-50'}`}>
        <span className={`text-xs ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
          {calcStats(note.noteType, content)}
        </span>
        <span className={`text-xs hidden sm:inline ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
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

      {/* 发送到邮箱弹窗 */}
      {showEmailDialog && (
        <NoteEmailDialog
          note={note}
          isDark={isDark}
          onClose={() => setShowEmailDialog(false)}
        />
      )}

      {/* 移动到文件夹弹窗 */}
      {showMoveDialog && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30" onClick={() => setShowMoveDialog(false)}>
          <div
            ref={moveDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="移动到文件夹"
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
            ref={shortcutsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="快捷键说明"
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