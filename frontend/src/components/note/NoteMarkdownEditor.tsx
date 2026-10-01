/**
 * NoteMarkdownEditor – 基于 @uiw/react-md-editor 的 Markdown 编辑器
 *
 * 能力概览：
 * - 使用官方内置完整工具条（加粗/标题/列表/表格/预览三态切换等），默认纯预览模式；
 * - 预览区追加 rehype-slug，让标题带上稳定 id 锚点（GitHub 风格 slug）；
 * - 解析正文标题生成大纲并通过 onOutlineChange 上报，支持点击定位（预览锚点 / textarea 光标）；
 * - live 模式下 textarea 与预览区双向同步滚动；
 * - 底部浮层显示字符数与预估阅读时长；
 * - 通过 onRegistryChange 上报命令表与菜单组，供顶部菜单栏与命令面板统一消费。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MDEditor, { type PreviewType } from '@uiw/react-md-editor';
import { getCommands, getExtraCommands } from '@uiw/react-md-editor/commands';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import type {
  NoteCommand,
  NoteEditorRegistry,
  NoteMenuGroup,
  NoteOutlineItem,
  NoteOutlineState,
} from '../../utils/noteCommands';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';

interface NoteMarkdownEditorProps {
  /** 笔记 id，切换时重置内容 */
  noteId: string;
  /** 正文（Markdown 纯文本） */
  content?: string;
  /** 内容重置标识，变化时强制重建编辑器 */
  contentResetKey?: number;
  /** 内容变更回调 */
  onChange?: (content: string) => void;
  /** 只读模式（仅渲染预览，不上报大纲） */
  readOnly?: boolean;
  /** 暗色主题 */
  isDark?: boolean;
  /** 上报可用命令与菜单组，供顶部菜单栏 / 命令面板消费 */
  onRegistryChange?: (registry: NoteEditorRegistry) => void;
  /** 上报大纲数据（只读时上报 null） */
  onOutlineChange?: (state: NoteOutlineState | null) => void;
}

/** remark 插件（编辑与预览共用） */
const previewPlugins = [remarkGfm, remarkMath];
/** rehype 插件：公式 / 代码高亮 / 标题锚点 id */
const previewRehypePlugins = [rehypeKatex, rehypeHighlight, rehypeSlug];

/** 逐行匹配 Markdown 标题（1-6 级） */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
/** 每 400 字符约等于 1 分钟阅读时长 */
const CHARS_PER_MINUTE = 400;

/** document.execCommand 是否可用（用于撤销/重做的可用性判断） */
const canExecCommand = typeof document !== 'undefined' && typeof document.execCommand === 'function';

/**
 * 从正文中解析大纲条目
 * @param text Markdown 正文
 * @returns 大纲条目列表，id 形如 'h-0'
 */
function parseOutline(text: string): NoteOutlineItem[] {
  const items: NoteOutlineItem[] = [];
  let index = 0;
  for (const line of text.split('\n')) {
    const matched = HEADING_RE.exec(line);
    if (!matched) continue;
    const headingText = matched[2].trim();
    if (!headingText) continue;
    items.push({ id: `h-${index}`, level: matched[1].length, text: headingText });
    index += 1;
  }
  return items;
}

/**
 * 从大纲 id 反解标题序号
 * @param id 形如 'h-3'
 * @returns 序号数字，非法时返回 -1
 */
function parseOutlineIndex(id: string): number {
  const index = Number(id.replace(/^h-/, ''));
  return Number.isFinite(index) ? index : -1;
}

/**
 * 计算第 index 个标题在正文中的字符偏移量（行首位置）
 * @param text Markdown 正文
 * @param index 标题序号（0 基）
 * @returns 字符偏移量，未命中时返回正文长度
 */
function findHeadingOffset(text: string, index: number): number {
  const lines = text.split('\n');
  let offset = 0;
  let seen = 0;
  for (const line of lines) {
    const matched = HEADING_RE.exec(line);
    if (matched && matched[2].trim()) {
      if (seen === index) return offset;
      seen += 1;
    }
    offset += line.length + 1;
  }
  return text.length;
}

const NoteMarkdownEditorCore: React.FC<NoteMarkdownEditorProps> = ({
  noteId,
  content,
  onChange,
  readOnly = false,
  isDark = false,
  onRegistryChange,
  onOutlineChange,
}) => {
  /** 最外层容器，用于定位 textarea 与预览容器 */
  const rootRef = useRef<HTMLDivElement | null>(null);
  /** 最新正文（避免闭包读到旧值） */
  const valueRef = useRef(content ?? '');
  /** 最新的 onChange 回调 */
  const onChangeRef = useRef(onChange);
  /** 最新的 onOutlineChange 回调（卸载时上报 null） */
  const onOutlineChangeRef = useRef(onOutlineChange);
  /** 最新只读状态 */
  const readOnlyRef = useRef(readOnly);
  /** 最新预览模式 */
  const previewRef = useRef<PreviewType>('preview');
  /** 同步滚动时用于抑制回环的元素 */
  const suppressRef = useRef<HTMLElement | null>(null);

  const [value, setValue] = useState(content ?? '');
  // 默认进入纯预览：打开笔记即可阅读渲染结果，需要改源码时用顶部按钮切回编辑/实时预览
  const [preview, setPreview] = useState<PreviewType>('preview');
  const prevNoteIdRef = useRef(noteId);

  /**
   * 获取编辑器内的 textarea 元素
   * @returns textarea 元素，未挂载时返回 null
   */
  const getTextarea = useCallback((): HTMLTextAreaElement | null => {
    return rootRef.current?.querySelector('textarea') ?? null;
  }, []);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    onOutlineChangeRef.current = onOutlineChange;
  }, [onOutlineChange]);

  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (prevNoteIdRef.current !== noteId) {
      prevNoteIdRef.current = noteId;
      const next = content ?? '';
      valueRef.current = next;
      setValue(next);
    }
  }, [noteId, content]);

  const handleChange = useCallback(
    (val?: string) => {
      const next = val ?? '';
      valueRef.current = next;
      setValue(next);
      onChange?.(next);
    },
    [onChange],
  );

  /**
   * 在 textarea 当前选区上包裹 / 插入文本，并恢复选区
   * @param before 选中文本前插入的内容
   * @param after 选中文本后插入的内容
   * @param placeholder 无选中文本时的占位文本
   */
  const applyTextEdit = useCallback(
    (before: string, after = '', placeholder = '') => {
      const el = getTextarea();
      if (!el) return;
      const { selectionStart: start, selectionEnd: end } = el;
      const current = valueRef.current;
      const selected = current.slice(start, end);
      const inner = selected || placeholder;
      const next = current.slice(0, start) + before + inner + after + current.slice(end);
      valueRef.current = next;
      setValue(next);
      onChangeRef.current?.(next);
      const selStart = start + before.length;
      const selEnd = selStart + inner.length;
      requestAnimationFrame(() => {
        const target = getTextarea();
        if (!target) return;
        target.focus();
        target.setSelectionRange(selStart, selEnd);
      });
    },
    [getTextarea],
  );

  /**
   * 执行一次撤销 / 重做
   * @param command 'undo' | 'redo'
   */
  const runHistoryCommand = useCallback(
    (command: 'undo' | 'redo') => {
      const el = getTextarea();
      if (!el) return;
      el.focus();
      document.execCommand(command);
    },
    [getTextarea],
  );

  /** 撤销 */
  const handleUndo = useCallback(() => runHistoryCommand('undo'), [runHistoryCommand]);
  /** 重做 */
  const handleRedo = useCallback(() => runHistoryCommand('redo'), [runHistoryCommand]);

  /** 加粗 */
  const handleBold = useCallback(() => applyTextEdit('**', '**', '粗体'), [applyTextEdit]);
  /** 斜体 */
  const handleItalic = useCallback(() => applyTextEdit('*', '*', '斜体'), [applyTextEdit]);
  /** 删除线 */
  const handleStrike = useCallback(() => applyTextEdit('~~', '~~', '删除线'), [applyTextEdit]);
  /** 行内代码 */
  const handleInlineCode = useCallback(() => applyTextEdit('`', '`', '代码'), [applyTextEdit]);
  /** 一级标题 */
  const handleHeading1 = useCallback(() => applyTextEdit('# '), [applyTextEdit]);
  /** 二级标题 */
  const handleHeading2 = useCallback(() => applyTextEdit('## '), [applyTextEdit]);
  /** 三级标题 */
  const handleHeading3 = useCallback(() => applyTextEdit('### '), [applyTextEdit]);
  /** 引用 */
  const handleQuote = useCallback(() => applyTextEdit('> '), [applyTextEdit]);
  /** 无序列表 */
  const handleBulletList = useCallback(() => applyTextEdit('- '), [applyTextEdit]);
  /** 有序列表 */
  const handleNumberedList = useCallback(() => applyTextEdit('1. '), [applyTextEdit]);
  /** 待办列表 */
  const handleCheckList = useCallback(() => applyTextEdit('- [ ] '), [applyTextEdit]);
  /** 代码块 */
  const handleCodeBlock = useCallback(() => applyTextEdit('\n```\n', '\n```\n'), [applyTextEdit]);
  /** 分隔线 */
  const handleHr = useCallback(() => applyTextEdit('\n---\n'), [applyTextEdit]);
  /** 三列表格模板 */
  const handleTable = useCallback(
    () => applyTextEdit('\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n| 内容 | 内容 | 内容 |\n'),
    [applyTextEdit],
  );
  /** 链接：用 []() 包裹选中文本 */
  const handleLink = useCallback(() => applyTextEdit('[', '](url)', '链接文本'), [applyTextEdit]);
  /** 图片：先询问图片地址，取消则不插入 */
  const handleImage = useCallback(() => {
    const url = window.prompt('图片地址');
    if (!url) return;
    applyTextEdit('![', `](${url})`, '图片描述');
  }, [applyTextEdit]);

  /** 切换到编辑模式 */
  const handlePreviewEdit = useCallback(() => setPreview('edit'), []);
  /** 切换到实时预览 */
  const handlePreviewLive = useCallback(() => setPreview('live'), []);
  /** 切换到纯预览 */
  const handlePreviewPreview = useCallback(() => setPreview('preview'), []);

  /** 内置工具条命令（避免每次渲染重建数组） */
  const editorCommands = useMemo(() => getCommands(), []);
  const editorExtraCommands = useMemo(() => getExtraCommands(), []);

  /** 大纲条目标识：仅在标题集合变化时才重建 items */
  const outlineSignature = useMemo(() => {
    const parts: string[] = [];
    for (const line of (value ?? '').split('\n')) {
      const matched = HEADING_RE.exec(line);
      if (matched && matched[2].trim()) parts.push(`${matched[1].length}:${matched[2].trim()}`);
    }
    return parts.join('|');
  }, [value]);

  const outlineItems = useMemo<NoteOutlineItem[]>(
    () => parseOutline(value),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [outlineSignature],
  );

  /**
   * 点击大纲条目时的定位逻辑：
   * 有预览区时优先滚动预览标题；纯编辑模式则定位 textarea 光标并估算滚动位置
   * @param id 大纲条目 id（'h-<index>'）
   */
  const handleOutlineSelect = useCallback((id: string) => {
    const index = parseOutlineIndex(id);
    if (index < 0) return;
    const root = rootRef.current;
    if (!root) return;

    if (previewRef.current !== 'edit') {
      const previewEl = root.querySelector('.wmde-markdown');
      const headings = previewEl?.querySelectorAll('h1,h2,h3,h4,h5,h6');
      const target = headings?.[index];
      if (target) {
        target.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      }
    }

    const textarea = getTextarea();
    if (!textarea) return;
    const text = valueRef.current ?? '';
    const offset = findHeadingOffset(text, index);
    textarea.focus();
    textarea.setSelectionRange(offset, offset);
    const maxScroll = textarea.scrollHeight - textarea.clientHeight;
    if (maxScroll > 0 && text.length > 0) {
      textarea.scrollTop = Math.round((offset / text.length) * maxScroll);
    } else {
      textarea.scrollTop = 0;
    }
  }, [getTextarea]);

  /** 上报大纲（只读时不报） */
  useEffect(() => {
    if (readOnly) {
      onOutlineChange?.(null);
      return;
    }
    onOutlineChange?.({ items: outlineItems, onSelect: handleOutlineSelect });
  }, [outlineItems, handleOutlineSelect, readOnly, onOutlineChange]);

  /** 卸载时清空大纲 */
  useEffect(() => {
    return () => {
      onOutlineChangeRef.current?.(null);
    };
  }, []);

  /** 同步内置工具条切换的预览模式（内置命令直接派发内部状态，需要回读根节点 class） */
  useEffect(() => {
    if (readOnly) return;
    const editorEl = rootRef.current?.querySelector('.w-md-editor') as HTMLElement | null;
    if (!editorEl) return;
    const syncPreview = () => {
      const matched = /w-md-editor-show-(edit|live|preview)/.exec(editorEl.className);
      if (matched) setPreview(matched[1] as PreviewType);
    };
    syncPreview();
    const observer = new MutationObserver(syncPreview);
    observer.observe(editorEl, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [readOnly]);

  /** live 模式下 textarea 与预览区双向同步滚动 */
  useEffect(() => {
    if (readOnly || preview !== 'live') return;
    const root = rootRef.current;
    if (!root) return;
    const textEl = (root.querySelector('.w-md-editor-area') ?? root.querySelector('textarea')) as HTMLElement | null;
    const previewEl = root.querySelector('.w-md-editor-preview') as HTMLElement | null;
    if (!textEl || !previewEl) return;

    let rafId = 0;
    /**
     * 按滚动比例把 from 的滚动位置映射到 to
     * @param from 触发滚动的元素
     * @param to 需要同步的元素
     */
    const sync = (from: HTMLElement, to: HTMLElement) => {
      if (suppressRef.current === from) return;
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const fromMax = from.scrollHeight - from.clientHeight;
        const toMax = to.scrollHeight - to.clientHeight;
        if (fromMax <= 0 || toMax <= 0) return;
        suppressRef.current = to;
        to.scrollTop = (from.scrollTop / fromMax) * toMax;
        requestAnimationFrame(() => {
          if (suppressRef.current === to) suppressRef.current = null;
        });
      });
    };

    const onTextScroll = () => sync(textEl, previewEl);
    const onPreviewScroll = () => sync(previewEl, textEl);
    textEl.addEventListener('scroll', onTextScroll, { passive: true });
    previewEl.addEventListener('scroll', onPreviewScroll, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      textEl.removeEventListener('scroll', onTextScroll);
      previewEl.removeEventListener('scroll', onPreviewScroll);
      suppressRef.current = null;
    };
  }, [preview, readOnly]);

  /** 编辑器命令与菜单组注册表（引用稳定） */
  const registry = useMemo<NoteEditorRegistry>(() => {
    const commands: NoteCommand[] = [
      {
        id: 'edit.undo',
        label: '撤销',
        shortcut: 'Mod+Z',
        keywords: 'undo 回退',
        run: handleUndo,
        isEnabled: () => canExecCommand && !readOnlyRef.current,
      },
      {
        id: 'edit.redo',
        label: '重做',
        shortcut: 'Mod+Shift+Z',
        keywords: 'redo 恢复',
        run: handleRedo,
        isEnabled: () => canExecCommand && !readOnlyRef.current,
      },
      { id: 'format.bold', label: '粗体', shortcut: 'Mod+B', keywords: 'bold strong', run: handleBold, isEnabled: () => !readOnlyRef.current },
      { id: 'format.italic', label: '斜体', shortcut: 'Mod+I', keywords: 'italic em', run: handleItalic, isEnabled: () => !readOnlyRef.current },
      { id: 'format.strike', label: '删除线', keywords: 'strike del', run: handleStrike, isEnabled: () => !readOnlyRef.current },
      { id: 'format.code', label: '行内代码', keywords: 'code inline', run: handleInlineCode, isEnabled: () => !readOnlyRef.current },
      { id: 'format.heading1', label: '一级标题', keywords: 'heading1 h1', run: handleHeading1, isEnabled: () => !readOnlyRef.current },
      { id: 'format.heading2', label: '二级标题', keywords: 'heading2 h2', run: handleHeading2, isEnabled: () => !readOnlyRef.current },
      { id: 'format.heading3', label: '三级标题', keywords: 'heading3 h3', run: handleHeading3, isEnabled: () => !readOnlyRef.current },
      { id: 'format.quote', label: '引用', keywords: 'quote blockquote', run: handleQuote, isEnabled: () => !readOnlyRef.current },
      { id: 'format.bulletList', label: '无序列表', keywords: 'list bullet', run: handleBulletList, isEnabled: () => !readOnlyRef.current },
      { id: 'format.numberedList', label: '有序列表', keywords: 'list ordered', run: handleNumberedList, isEnabled: () => !readOnlyRef.current },
      { id: 'format.checkList', label: '待办列表', keywords: 'todo task check', run: handleCheckList, isEnabled: () => !readOnlyRef.current },
      { id: 'format.codeBlock', label: '代码块', keywords: 'code block fence', run: handleCodeBlock, isEnabled: () => !readOnlyRef.current },
      { id: 'format.hr', label: '分隔线', keywords: 'hr divider', run: handleHr, isEnabled: () => !readOnlyRef.current },
      { id: 'format.table', label: '表格', keywords: 'table grid', run: handleTable, isEnabled: () => !readOnlyRef.current },
      { id: 'format.link', label: '链接', run: handleLink, isEnabled: () => !readOnlyRef.current },
      { id: 'format.image', label: '图片', run: handleImage, isEnabled: () => !readOnlyRef.current },
      {
        id: 'view.preview.edit',
        label: '编辑模式',
        run: handlePreviewEdit,
        isEnabled: () => !readOnlyRef.current,
        isChecked: () => previewRef.current === 'edit',
      },
      {
        id: 'view.preview.live',
        label: '实时预览',
        run: handlePreviewLive,
        isEnabled: () => !readOnlyRef.current,
        isChecked: () => previewRef.current === 'live',
      },
      {
        id: 'view.preview.preview',
        label: '纯预览',
        run: handlePreviewPreview,
        isEnabled: () => !readOnlyRef.current,
        isChecked: () => previewRef.current === 'preview',
      },
    ];

    const groups: NoteMenuGroup[] = [
      {
        id: 'edit',
        items: [{ commandId: 'edit.undo' }, { commandId: 'edit.redo' }],
      },
      {
        id: 'insert',
        items: [
          { commandId: 'format.link' },
          { commandId: 'format.image' },
          { commandId: 'format.table' },
          { commandId: 'format.hr' },
          { commandId: 'format.codeBlock', separatorBefore: true },
        ],
      },
      {
        id: 'format',
        items: [
          { commandId: 'format.bold' },
          { commandId: 'format.italic' },
          { commandId: 'format.strike' },
          { commandId: 'format.code' },
          { commandId: 'format.heading1', separatorBefore: true },
          { commandId: 'format.heading2' },
          { commandId: 'format.heading3' },
          { commandId: 'format.quote', separatorBefore: true },
          { commandId: 'format.bulletList' },
          { commandId: 'format.numberedList' },
          { commandId: 'format.checkList' },
        ],
      },
      {
        id: 'view',
        items: [
          { commandId: 'view.preview.edit' },
          { commandId: 'view.preview.live' },
          { commandId: 'view.preview.preview' },
        ],
      },
    ];

    return { commands, groups };
  }, [
    handleUndo,
    handleRedo,
    handleBold,
    handleItalic,
    handleStrike,
    handleInlineCode,
    handleHeading1,
    handleHeading2,
    handleHeading3,
    handleQuote,
    handleBulletList,
    handleNumberedList,
    handleCheckList,
    handleCodeBlock,
    handleHr,
    handleTable,
    handleLink,
    handleImage,
    handlePreviewEdit,
    handlePreviewLive,
    handlePreviewPreview,
  ]);

  /** 上报命令注册表 */
  useEffect(() => {
    onRegistryChange?.(registry);
  }, [registry, onRegistryChange]);

  const charCount = value.length;
  const readingMinutes = Math.max(1, Math.round(charCount / CHARS_PER_MINUTE));
  const showStats = !readOnly && preview !== 'preview';

  return (
    <div
      ref={rootRef}
      className={`note-md-editor-root relative w-full h-full flex flex-col min-h-0 ${isDark ? 'note-md-dark' : ''}`}
      data-color-mode={isDark ? 'dark' : 'light'}
    >
      {readOnly ? (
        <MDEditor.Markdown
          source={value}
          remarkPlugins={previewPlugins}
          rehypePlugins={previewRehypePlugins}
          className="p-4 flex-1 overflow-auto"
        />
      ) : (
        <MDEditor
          value={value}
          onChange={handleChange}
          height="100%"
          visibleDragbar={false}
          preview={preview}
          commands={editorCommands}
          extraCommands={editorExtraCommands}
          enableScroll={false}
          className="flex-1 min-h-0"
          textareaProps={{ placeholder: '输入 Markdown 内容，支持 GFM、公式与代码高亮' }}
          previewOptions={{
            remarkPlugins: previewPlugins,
            rehypePlugins: previewRehypePlugins,
          }}
        />
      )}
      {showStats && (
        <div
          className={`pointer-events-none absolute bottom-1 right-3 text-[11px] select-none ${
            isDark ? 'text-gray-500' : 'text-gray-400'
          }`}
        >
          {charCount} 字符 · 约 {readingMinutes} 分钟
        </div>
      )}
    </div>
  );
};

const NoteMarkdownEditor: React.FC<NoteMarkdownEditorProps> = (props) => {
  const { contentResetKey = 0, ...rest } = props;
  return <NoteMarkdownEditorCore key={contentResetKey} {...rest} />;
};

export default NoteMarkdownEditor;