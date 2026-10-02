/**
 * NoteRichTextEditor – 基于 BlockNote 的块式富文本编辑器（类 Notion）
 *
 * 单实例 + replaceBlocks 切换笔记；contentResetKey 变化时整实例重建（AI 刷新）。
 * 同时承担两件对外协作：
 * 1. 通过 onRegistryChange 上报本编辑器支持的命令（NoteCommand）与菜单分组（NoteMenuGroup），
 *    供顶部统一菜单栏与命令面板消费；
 * 2. 通过 onOutlineChange 上报由 heading 块抽取的大纲（NoteOutlineState）。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { BlockNoteEditor, PartialBlock } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import {
  Bold, Italic, Strikethrough, Underline, Code,
  List, ListOrdered, CheckSquare,
  Heading1, Heading2, Heading3,
  Undo2, Redo2,
  AlignLeft, AlignCenter, AlignRight,
  Link2, Highlighter, Palette, Eraser, Table, Minus, Quote, ImagePlus, ChevronDown, Mic,
} from 'lucide-react';
import { parseBlockNoteContent } from '../../utils/blocknoteContent';
import { uploadImageAsDataUrl } from '../../utils/blocknoteImageUpload';
import type {
  NoteCommand,
  NoteEditorRegistry,
  NoteMenuGroup,
  NoteOutlineItem,
  NoteOutlineState,
} from '../../utils/noteCommands';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

/** 空文档默认块 */
const DEFAULT_BLOCKS: PartialBlock[] = [{ type: 'paragraph', props: { textAlignment: 'left' } }];

/** 大纲刷新节流延迟（毫秒），避免每次输入都全量扫描文档 */
const OUTLINE_THROTTLE_MS = 300;

/**
 * 可选文字颜色 / 背景高亮色板项
 */
interface ColorOption {
  /** BlockNote 颜色标识，如 'red'、'default' */
  id: string;
  /** 中文展示名 */
  label: string;
  /** 色板圆点显示色（default 用透明 + 斜杠图标表示） */
  hex: string;
}

/** 文字颜色 / 背景高亮统一色板（与 BlockNote 默认色名保持一致） */
const COLOR_PALETTE: ColorOption[] = [
  { id: 'default', label: '默认', hex: 'transparent' },
  { id: 'gray', label: '灰', hex: '#9ca3af' },
  { id: 'brown', label: '棕', hex: '#a16207' },
  { id: 'red', label: '红', hex: '#ef4444' },
  { id: 'orange', label: '橙', hex: '#f97316' },
  { id: 'yellow', label: '黄', hex: '#eab308' },
  { id: 'green', label: '绿', hex: '#22c55e' },
  { id: 'blue', label: '蓝', hex: '#3b82f6' },
  { id: 'purple', label: '紫', hex: '#a855f7' },
  { id: 'pink', label: '粉', hex: '#ec4899' },
];

/** 块类型下拉的可选值（value 与展示文案一一对应） */
const BLOCK_TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'paragraph', label: '正文' },
  { value: 'heading1', label: '标题 1' },
  { value: 'heading2', label: '标题 2' },
  { value: 'heading3', label: '标题 3' },
  { value: 'heading4', label: '标题 4' },
  { value: 'heading5', label: '标题 5' },
  { value: 'heading6', label: '标题 6' },
  { value: 'quote', label: '引用' },
  { value: 'codeBlock', label: '代码块' },
];

/**
 * NoteRichTextEditor 组件属性
 */
interface NoteRichTextEditorProps {
  /** 当前笔记 id（切换笔记时重置内部同步状态） */
  noteId: string;
  /** 笔记内容（BlockNote 块数组形式） */
  content?: Record<string, unknown>;
  /** 内容重置键，变化时整实例重建 */
  contentResetKey?: number;
  /** 内容变化回调 */
  onChange?: (content: Record<string, unknown>) => void;
  /** 是否只读 */
  readOnly?: boolean;
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 上报可用命令与菜单分组 */
  onRegistryChange?: (registry: NoteEditorRegistry) => void;
  /** 上报大纲数据（只读或无标题时上报 null） */
  onOutlineChange?: (state: NoteOutlineState | null) => void;
  /** 请求打开录音转写面板（由上层面板渲染并管理其开关） */
  onOpenRecording?: () => void;
}

/**
 * 颜色色板下拉菜单组件（文字颜色 / 背景高亮共用）
 */
interface ColorPaletteMenuProps {
  /** 是否暗色主题 */
  isDark: boolean;
  /** 触发按钮图标 */
  icon: React.ReactNode;
  /** 触发按钮提示文案 */
  title: string;
  /** 触发按钮样式类名 */
  btnCls: string;
  /** 选择颜色回调（传入 color.id） */
  onPick: (colorId: string) => void;
}

/**
 * 色板下拉：点击彩色圆点应用对应文字颜色 / 背景高亮
 * @param props 组件属性
 * @returns 下拉按钮与色板面板
 */
const ColorPaletteMenu: React.FC<ColorPaletteMenuProps> = ({ isDark, icon, title, btnCls, onPick }) => {
  /** 面板是否展开 */
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        className={`${btnCls} flex items-center`}
        title={title}
        onClick={() => setOpen(v => !v)}
      >
        {icon}
        <ChevronDown size={10} className="ml-0.5" />
      </button>
      {open && (
        <>
          {/* 点击空白处关闭面板 */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          {/* w-max：定位父容器仅为窄按钮，不加会被压缩导致格子重叠 */}
          <div
            className={`absolute z-20 top-full left-0 mt-1 p-2 rounded-lg border shadow-lg grid grid-cols-5 gap-1.5 w-max ${
              isDark ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'
            }`}
          >
            {COLOR_PALETTE.map(color => (
              <button
                key={color.id}
                type="button"
                title={color.label}
                onClick={() => {
                  onPick(color.id);
                  setOpen(false);
                }}
                className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                  isDark ? 'border-gray-500' : 'border-gray-300'
                }`}
                style={color.id === 'default' ? undefined : { backgroundColor: color.hex }}
              >
                {color.id === 'default' ? (
                  <Minus size={10} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
                ) : null}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

/**
 * 富文本编辑器核心实现
 * @param props 编辑器属性
 * @returns 工具栏 + BlockNoteView
 */
const NoteRichTextEditorCore: React.FC<NoteRichTextEditorProps> = ({
  noteId,
  content,
  onChange,
  readOnly = false,
  isDark = false,
  onRegistryChange,
  onOutlineChange,
  onOpenRecording,
}) => {
  const editor: BlockNoteEditor = useCreateBlockNote({
    initialContent: parseBlockNoteContent(content) ?? DEFAULT_BLOCKS,
    uploadFile: async (file) => {
      try {
        return await uploadImageAsDataUrl(file);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '图片粘贴失败');
        throw err;
      }
    },
  });

  /** 编辑器实例引用：供 useCallback([]) 稳定回调读取最新实例，避免命令闭包随渲染变化 */
  const editorRef = useRef<BlockNoteEditor>(editor);
  editorRef.current = editor;

  const prevNoteIdRef = useRef(noteId);
  const contentSigRef = useRef('');
  const suppressChangeRef = useRef(true);
  /** 本地编辑回传 content 时跳过 replaceBlocks；绑定 noteId 避免切换笔记时误跳过 */
  const skipNextContentSyncRef = useRef<string | null>(null);
  /** 大纲刷新节流定时器 */
  const outlineTimerRef = useRef<number | null>(null);
  /** 隐藏的图片文件选择输入框 */
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** 最新的大纲回调引用：供卸载清理使用，避免回调换引用时误清空大纲 */
  const onOutlineChangeRef = useRef(onOutlineChange);
  onOutlineChangeRef.current = onOutlineChange;

  /** 当前光标所在块的类型（驱动工具栏块类型下拉的选中值） */
  const [currentBlockType, setCurrentBlockType] = useState<string>('paragraph');
  /** 当前大纲条目（仅在变化时更新，保证上报引用稳定） */
  const [outlineItems, setOutlineItems] = useState<NoteOutlineItem[]>([]);

  /**
   * 从当前光标位置推断下拉选中值
   * @returns 形如 'paragraph' / 'heading1' / 'quote' / 'codeBlock' 的值
   */
  const resolveBlockTypeValue = useCallback((): string => {
    try {
      const block = editorRef.current.getTextCursorPosition().block as any;
      if (block?.type === 'heading') {
        const level = Number((block.props as any)?.level ?? 1);
        return `heading${Math.min(Math.max(level, 1), 6)}`;
      }
      return block?.type ?? 'paragraph';
    } catch {
      return 'paragraph';
    }
  }, []);

  /**
   * 用当前光标块类型同步下拉选中值
   * @returns 无
   */
  const syncBlockTypeFromCursor = useCallback(() => {
    setCurrentBlockType(resolveBlockTypeValue());
  }, [resolveBlockTypeValue]);

  /**
   * 递归收集文档中的 heading 块作为大纲条目
   * @returns 大纲条目数组
   */
  const collectOutlineItems = useCallback((): NoteOutlineItem[] => {
    const items: NoteOutlineItem[] = [];
    const walk = (blocks: any[]) => {
      for (const block of blocks) {
        if (block?.type === 'heading') {
          const text = Array.isArray(block.content)
            ? block.content.map((c: any) => c?.text ?? '').join('')
            : '';
          items.push({
            id: block.id,
            level: Number((block.props as any)?.level ?? 1),
            text: text || '未命名标题',
          });
        }
        if (Array.isArray(block?.children) && block.children.length > 0) walk(block.children);
      }
    };
    walk(editorRef.current.document as any[]);
    return items;
  }, []);

  /**
   * 点击大纲条目：定位到对应块并聚焦
   * @param id 目标块 id
   * @returns 无
   */
  const handleOutlineSelect = useCallback((id: string) => {
    const findBlock = (blocks: any[]): any | null => {
      for (const block of blocks) {
        if (block?.id === id) return block;
        if (Array.isArray(block?.children) && block.children.length > 0) {
          const found = findBlock(block.children);
          if (found) return found;
        }
      }
      return null;
    };
    const target = findBlock(editorRef.current.document as any[]);
    if (!target) return;
    editorRef.current.setTextCursorPosition(target, 'start');
    editorRef.current.focus();
  }, []);

  /**
   * 立即刷新大纲（仅更新内部状态，避免无变化的重复渲染）
   * @returns 无
   */
  const refreshOutline = useCallback(() => {
    if (readOnly) return;
    setOutlineItems(prev => {
      const next = collectOutlineItems();
      const same = prev.length === next.length
        && prev.every((item, index) => item.id === next[index].id
          && item.level === next[index].level
          && item.text === next[index].text);
      return same ? prev : next;
    });
  }, [readOnly, collectOutlineItems]);

  /**
   * 节流刷新大纲（输入过程中避免全量扫描）
   * @returns 无
   */
  const scheduleOutlineRefresh = useCallback(() => {
    if (outlineTimerRef.current !== null) window.clearTimeout(outlineTimerRef.current);
    outlineTimerRef.current = window.setTimeout(() => {
      outlineTimerRef.current = null;
      refreshOutline();
    }, OUTLINE_THROTTLE_MS);
  }, [refreshOutline]);

  /**
   * 用给定内容替换整篇文档（AI 刷新 / 切换笔记）
   * @param nextContent 新内容
   * @returns 无
   */
  const applyContent = useCallback((nextContent?: Record<string, unknown>) => {
    const blocks = parseBlockNoteContent(nextContent) ?? DEFAULT_BLOCKS;
    editorRef.current.replaceBlocks(editorRef.current.document, blocks);
    suppressChangeRef.current = true;
    window.setTimeout(() => {
      suppressChangeRef.current = false;
    }, 800);
    // 内容整体替换后立即刷新大纲与光标块类型
    refreshOutline();
    syncBlockTypeFromCursor();
  }, [refreshOutline, syncBlockTypeFromCursor]);

  useEffect(() => {
    suppressChangeRef.current = true;
    const timer = window.setTimeout(() => {
      suppressChangeRef.current = false;
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const sig = JSON.stringify(content ?? null);
    if (prevNoteIdRef.current !== noteId) {
      prevNoteIdRef.current = noteId;
      skipNextContentSyncRef.current = null;
      contentSigRef.current = sig;
      applyContent(content);
      return;
    }
    if (skipNextContentSyncRef.current === noteId) {
      skipNextContentSyncRef.current = null;
      contentSigRef.current = sig;
      return;
    }
    if (contentSigRef.current !== sig) {
      contentSigRef.current = sig;
      applyContent(content);
    }
  }, [noteId, content, applyContent]);

  // 首次挂载 / 只读状态变化时刷新大纲
  useEffect(() => {
    refreshOutline();
  }, [refreshOutline]);

  // 订阅光标选择变化，实时同步块类型下拉
  useEffect(() => {
    const unsubscribe = editor.onSelectionChange(() => {
      syncBlockTypeFromCursor();
    });
    return () => {
      unsubscribe?.();
    };
  }, [editor, syncBlockTypeFromCursor]);

  // 卸载时清理节流定时器并清空大纲
  useEffect(() => () => {
    if (outlineTimerRef.current !== null) window.clearTimeout(outlineTimerRef.current);
    onOutlineChangeRef.current?.(null);
  }, []);

  /**
   * 内容变化：节流刷新大纲 + 回传内容（保持既有 suppress/skip 逻辑不变）
   * @returns 无
   */
  const handleChange = useCallback(() => {
    scheduleOutlineRefresh();
    syncBlockTypeFromCursor();
    if (suppressChangeRef.current || !onChange || !editorRef.current) return;
    skipNextContentSyncRef.current = noteId;
    onChange({ blocks: editorRef.current.document });
  }, [onChange, noteId, scheduleOutlineRefresh, syncBlockTypeFromCursor]);

  const btnCls = `p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-600' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-200'}`;
  const sepCls = `w-px h-5 mx-1 ${isDark ? 'bg-gray-600' : 'bg-gray-200'}`;

  // ---------------------------------------------------------------------------
  // 稳定动作（均为 useCallback([])，只依赖 ref，供工具栏与命令注册复用）
  // ---------------------------------------------------------------------------

  /**
   * 切换行内样式（粗体/斜体等）
   * @param style 样式名
   * @returns 无
   */
  const toggleStyle = useCallback((style: string) => {
    const ed = editorRef.current;
    ed.focus();
    ed.toggleStyles({ [style]: true } as any);
  }, []);

  /**
   * 把当前光标块转换为指定块类型
   * @param type 块类型
   * @param props 块属性
   * @returns 无
   */
  const insertBlock = useCallback((type: string, props?: Record<string, unknown>) => {
    const ed = editorRef.current;
    ed.focus();
    const block = ed.getTextCursorPosition().block;
    ed.updateBlock(block, { type: type as any, props: props as any });
  }, []);

  /**
   * 设置当前块对齐方式
   * @param align 对齐方式
   * @returns 无
   */
  const setAlignment = useCallback((align: 'left' | 'center' | 'right') => {
    const ed = editorRef.current;
    ed.focus();
    const block = ed.getTextCursorPosition().block;
    ed.updateBlock(block, { props: { textAlignment: align } as any });
  }, []);

  /**
   * 处理块类型下拉的切换
   * @param value 下拉值（如 'heading2' / 'paragraph'）
   * @returns 无
   */
  const handleBlockTypeSelect = useCallback((value: string) => {
    if (value.startsWith('heading')) {
      insertBlock('heading', { level: Number(value.slice('heading'.length)) || 1 });
      return;
    }
    insertBlock(value);
  }, [insertBlock]);

  /**
   * 应用文字颜色
   * @param color BlockNote 颜色标识
   * @returns 无
   */
  const applyTextColor = useCallback((color: string) => {
    const ed = editorRef.current;
    ed.focus();
    if (color === 'default') ed.removeStyles({ textColor: 'default' });
    else ed.addStyles({ textColor: color });
  }, []);

  /**
   * 应用文字背景高亮
   * @param color BlockNote 颜色标识
   * @returns 无
   */
  const applyBackgroundColor = useCallback((color: string) => {
    const ed = editorRef.current;
    ed.focus();
    if (color === 'default') ed.removeStyles({ backgroundColor: 'default' });
    else ed.addStyles({ backgroundColor: color });
  }, []);

  /**
   * 清除当前选区全部行内格式
   * @returns 无
   */
  const clearFormatting = useCallback(() => {
    const ed = editorRef.current;
    ed.focus();
    ed.removeStyles({
      bold: true,
      italic: true,
      underline: true,
      strike: true,
      code: true,
      textColor: true,
      backgroundColor: true,
    } as any);
  }, []);

  /**
   * 为选中文字添加链接（未选中文字时提示）
   * @returns 无
   */
  const insertLink = useCallback(() => {
    const ed = editorRef.current;
    ed.focus();
    if (!ed.getSelectedText()) {
      toast.error('请先选中要添加链接的文字');
      return;
    }
    const url = window.prompt('链接地址', 'https://');
    if (url) ed.createLink(url);
  }, []);

  /**
   * 在当前块之后插入图片块
   * @param url 图片地址（网络 URL 或 dataURL）
   * @param name 图片名称
   * @returns 无
   */
  const insertImageBlock = useCallback((url: string, name = '') => {
    const ed = editorRef.current;
    ed.focus();
    ed.insertBlocks(
      [{ type: 'image', props: { url, name, caption: '', showPreview: true } } as any],
      ed.getTextCursorPosition().block,
      'after',
    );
  }, []);

  /**
   * 在当前光标块之后插入一组块（供录音转写面板「插入笔记」复用）。
   * @param blocks BlockNote 块数组
   * @returns 无
   */
  const insertBlocksAfterCursor = useCallback((blocks: PartialBlock[]) => {
    const ed = editorRef.current;
    if (!ed || !blocks.length) return;
    ed.focus();
    ed.insertBlocks(blocks, ed.getTextCursorPosition().block, 'after');
  }, []);

  /**
   * 插入图片：先询问网络地址，留空则打开本地文件选择
   * @returns 无
   */
  const insertImage = useCallback(() => {
    const input = window.prompt('图片地址（留空则选择本地文件）', 'https://');
    const trimmed = (input ?? '').trim();
    if (trimmed && trimmed !== 'https://') {
      insertImageBlock(trimmed);
      return;
    }
    fileInputRef.current?.click();
  }, [insertImageBlock]);

  /**
   * 本地图片文件选择回调：转 dataURL 后插入
   * @param e 文件输入变化事件
   * @returns Promise<void>
   */
  const handleImageFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await uploadImageAsDataUrl(file);
      insertImageBlock(dataUrl, file.name);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '插入图片失败');
    }
  }, [insertImageBlock]);

  /**
   * 插入 3×3 空表格
   * @returns 无
   */
  const insertTable = useCallback(() => {
    const ed = editorRef.current;
    try {
      ed.focus();
      const tableBlock = {
        type: 'table',
        props: {},
        content: {
          type: 'tableContent',
          columnWidths: [],
          headerRows: 1,
          headerCols: 0,
          rows: [
            { cells: ['列 1', '列 2', '列 3'] },
            { cells: ['', '', ''] },
            { cells: ['', '', ''] },
          ],
        },
      } as any;
      ed.insertBlocks([tableBlock], ed.getTextCursorPosition().block, 'after');
    } catch {
      toast.error('插入表格失败');
    }
  }, []);

  /**
   * 插入分隔线
   * @returns 无
   */
  const insertDivider = useCallback(() => {
    const ed = editorRef.current;
    ed.focus();
    ed.insertBlocks([{ type: 'divider' } as any], ed.getTextCursorPosition().block, 'after');
  }, []);

  /**
   * 全选当前文档
   * @returns 无
   */
  const selectAll = useCallback(() => {
    editorRef.current.focus();
    document.execCommand('selectAll');
  }, []);

  /**
   * 撤销
   * @returns 无
   */
  const undo = useCallback(() => {
    editorRef.current.undo();
  }, []);

  /**
   * 重做
   * @returns 无
   */
  const redo = useCallback(() => {
    editorRef.current.redo();
  }, []);

  // ---------------------------------------------------------------------------
  // 命令注册（引用稳定：commands 闭包仅依赖上面的 useCallback([]) 稳定函数）
  // ---------------------------------------------------------------------------
  const registry = useMemo<NoteEditorRegistry>(() => {
    /**
     * 构造一条命令
     * @param id 命令 id
     * @param label 展示标签
     * @param run 执行体
     * @param shortcut 规范化快捷键
     * @param keywords 搜索关键词
     * @returns 命令对象
     */
    const cmd = (
      id: string,
      label: string,
      run: () => void,
      shortcut?: string,
      keywords?: string,
    ): NoteCommand => ({ id, label, run, shortcut, keywords });

    const commands: NoteCommand[] = [
      // 编辑
      cmd('edit.undo', '撤销', undo, 'Mod+Z', 'undo 撤回'),
      cmd('edit.redo', '重做', redo, 'Mod+Shift+Z', 'redo 恢复'),
      cmd('edit.selectAll', '全选', selectAll, 'Mod+A', 'select all 选择全部'),
      // 行内格式
      cmd('format.bold', '粗体', () => toggleStyle('bold'), 'Mod+B', 'bold 加粗'),
      cmd('format.italic', '斜体', () => toggleStyle('italic'), 'Mod+I', 'italic 倾斜'),
      cmd('format.underline', '下划线', () => toggleStyle('underline'), 'Mod+U', 'underline'),
      cmd('format.strike', '删除线', () => toggleStyle('strike'), 'Mod+Shift+S', 'strike 删除线'),
      cmd('format.code', '行内代码', () => toggleStyle('code'), 'Mod+E', 'code 代码'),
      cmd('format.clear', '清除格式', clearFormatting, undefined, 'clear 清除 样式 格式'),
      // 插入 - 块类型
      cmd('insert.paragraph', '正文', () => insertBlock('paragraph'), undefined, 'paragraph text 普通 段落'),
      cmd('insert.heading1', '标题 1', () => insertBlock('heading', { level: 1 }), 'Mod+Alt+1', 'heading h1 标题1'),
      cmd('insert.heading2', '标题 2', () => insertBlock('heading', { level: 2 }), 'Mod+Alt+2', 'heading h2 标题2'),
      cmd('insert.heading3', '标题 3', () => insertBlock('heading', { level: 3 }), 'Mod+Alt+3', 'heading h3 标题3'),
      cmd('insert.heading4', '标题 4', () => insertBlock('heading', { level: 4 }), 'Mod+Alt+4', 'heading h4 标题4'),
      cmd('insert.heading5', '标题 5', () => insertBlock('heading', { level: 5 }), 'Mod+Alt+5', 'heading h5 标题5'),
      cmd('insert.heading6', '标题 6', () => insertBlock('heading', { level: 6 }), 'Mod+Alt+6', 'heading h6 标题6'),
      cmd('insert.quote', '引用', () => insertBlock('quote'), undefined, 'quote 引用块'),
      cmd('insert.codeBlock', '代码块', () => insertBlock('codeBlock'), undefined, 'code block 代码段'),
      // 插入 - 列表 / 其它块
      cmd('insert.bulletList', '无序列表', () => insertBlock('bulletListItem'), 'Mod+Shift+8', 'bullet list 项目符号'),
      cmd('insert.numberedList', '有序列表', () => insertBlock('numberedListItem'), 'Mod+Shift+7', 'numbered list 编号'),
      cmd('insert.checkList', '待办列表', () => insertBlock('checkListItem'), 'Mod+Shift+9', 'todo checkbox 任务'),
      cmd('insert.divider', '分隔线', insertDivider, undefined, 'divider hr 分割线 水平线'),
      cmd('insert.table', '表格', insertTable, undefined, 'table 表格 插入'),
      cmd('insert.image', '插入图片', insertImage, undefined, 'image picture 图片 上传'),
      cmd('insert.recording', '录音转写', () => onOpenRecording?.(), undefined, 'record audio mic 录音 语音 转写'),
      cmd('insert.link', '插入链接', insertLink, 'Mod+K', 'link url 超链接'),
      // 视图 - 对齐
      cmd('view.align.left', '左对齐', () => setAlignment('left'), undefined, 'align left 左对齐'),
      cmd('view.align.center', '居中', () => setAlignment('center'), undefined, 'align center 居中'),
      cmd('view.align.right', '右对齐', () => setAlignment('right'), undefined, 'align right 右对齐'),
    ];

    // 颜色命令：仅注册到命令表供命令面板搜索，不出现在菜单中
    for (const color of COLOR_PALETTE) {
      commands.push(
        cmd(`format.textColor.${color.id}`, `文字颜色：${color.label}`, () => applyTextColor(color.id), undefined, `text color 文字颜色 ${color.label} ${color.id}`),
        cmd(`format.bgColor.${color.id}`, `背景高亮：${color.label}`, () => applyBackgroundColor(color.id), undefined, `background highlight 背景 高亮 ${color.label} ${color.id}`),
      );
    }

    const groups: NoteMenuGroup[] = [
      {
        id: 'edit',
        items: [
          { commandId: 'edit.undo' },
          { commandId: 'edit.redo' },
          { commandId: 'edit.selectAll', separatorBefore: true },
        ],
      },
      {
        id: 'insert',
        items: [
          { commandId: 'insert.paragraph' },
          { commandId: 'insert.heading1' },
          { commandId: 'insert.heading2' },
          { commandId: 'insert.heading3' },
          { commandId: 'insert.heading4' },
          { commandId: 'insert.heading5' },
          { commandId: 'insert.heading6' },
          { commandId: 'insert.quote', separatorBefore: true },
          { commandId: 'insert.codeBlock' },
          { commandId: 'insert.divider' },
          { commandId: 'insert.table' },
          { commandId: 'insert.image' },
          { commandId: 'insert.recording' },
          { commandId: 'insert.link' },
          { commandId: 'insert.bulletList', separatorBefore: true },
          { commandId: 'insert.numberedList' },
          { commandId: 'insert.checkList' },
          { commandId: 'view.align.left', separatorBefore: true },
          { commandId: 'view.align.center' },
          { commandId: 'view.align.right' },
        ],
      },
      {
        id: 'format',
        items: [
          { commandId: 'format.bold' },
          { commandId: 'format.italic' },
          { commandId: 'format.underline' },
          { commandId: 'format.strike' },
          { commandId: 'format.code' },
          { commandId: 'format.clear' },
          {
            labelOverride: '文字颜色',
            separatorBefore: true,
            children: COLOR_PALETTE.map(color => ({
              onSelect: () => applyTextColor(color.id),
              labelOverride: `文字颜色：${color.label}`,
            })),
          },
          {
            labelOverride: '背景高亮',
            children: COLOR_PALETTE.map(color => ({
              onSelect: () => applyBackgroundColor(color.id),
              labelOverride: `背景高亮：${color.label}`,
            })),
          },
        ],
      },
    ];

    return { commands, groups, insertBlocksAfterCursor };
  }, [
    undo, redo, selectAll,
    toggleStyle, clearFormatting, insertBlock, setAlignment,
    insertDivider, insertTable, insertImage, insertLink,
    applyTextColor, applyBackgroundColor,
    insertBlocksAfterCursor, onOpenRecording,
  ]);

  // 上报 registry
  useEffect(() => {
    onRegistryChange?.(registry);
  }, [registry, onRegistryChange]);

  // 上报大纲（只读时为 null）
  useEffect(() => {
    if (readOnly) {
      onOutlineChange?.(null);
      return;
    }
    onOutlineChange?.({ items: outlineItems, onSelect: handleOutlineSelect });
  }, [outlineItems, handleOutlineSelect, onOutlineChange, readOnly]);

  return (
    <div className="note-rich-text-editor w-full h-full flex flex-col overflow-hidden min-h-0">
      {!readOnly && (
        <div className={`flex items-center gap-0.5 px-3 py-1.5 border-b shrink-0 flex-wrap ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-100 bg-gray-50/50'}`}>
          <button type="button" className={btnCls} onClick={undo} title="撤销 (Ctrl+Z)"><Undo2 size={16} /></button>
          <button type="button" className={btnCls} onClick={redo} title="重做 (Ctrl+Y)"><Redo2 size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => insertBlock('heading', { level: 1 })} title="标题1"><Heading1 size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('heading', { level: 2 })} title="标题2"><Heading2 size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('heading', { level: 3 })} title="标题3"><Heading3 size={16} /></button>
          <select
            value={currentBlockType}
            onChange={(e) => handleBlockTypeSelect(e.target.value)}
            title="块类型"
            className={`text-xs rounded-md border px-1.5 py-1 outline-none ${isDark ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-200 text-gray-700'}`}
          >
            {BLOCK_TYPE_OPTIONS.map(option => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => toggleStyle('bold')} title="粗体"><Bold size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('italic')} title="斜体"><Italic size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('underline')} title="下划线"><Underline size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('strike')} title="删除线"><Strikethrough size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('code')} title="行内代码"><Code size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('codeBlock')} title="代码块"><Code size={16} className="opacity-70" /></button>
          <ColorPaletteMenu
            isDark={isDark}
            btnCls={btnCls}
            icon={<Palette size={16} />}
            title="文字颜色"
            onPick={applyTextColor}
          />
          <ColorPaletteMenu
            isDark={isDark}
            btnCls={btnCls}
            icon={<Highlighter size={16} />}
            title="背景高亮"
            onPick={applyBackgroundColor}
          />
          <button type="button" className={btnCls} onClick={clearFormatting} title="清除格式"><Eraser size={16} /></button>
          <button type="button" className={btnCls} onClick={insertLink} title="插入链接"><Link2 size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => insertBlock('bulletListItem')} title="无序列表"><List size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('numberedListItem')} title="有序列表"><ListOrdered size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('checkListItem')} title="待办列表"><CheckSquare size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => insertBlock('quote')} title="引用"><Quote size={16} /></button>
          <button type="button" className={btnCls} onClick={insertTable} title="插入表格"><Table size={16} /></button>
          <button type="button" className={btnCls} onClick={insertDivider} title="插入分隔线"><Minus size={16} /></button>
          <button type="button" className={btnCls} onClick={insertImage} title="插入图片"><ImagePlus size={16} /></button>
          <button type="button" className={btnCls} onClick={() => onOpenRecording?.()} title="录音转写"><Mic size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => setAlignment('left')} title="左对齐"><AlignLeft size={16} /></button>
          <button type="button" className={btnCls} onClick={() => setAlignment('center')} title="居中"><AlignCenter size={16} /></button>
          <button type="button" className={btnCls} onClick={() => setAlignment('right')} title="右对齐"><AlignRight size={16} /></button>
        </div>
      )}
      <div className="flex-1 min-h-0 overflow-auto flex flex-col">
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme={isDark ? 'dark' : 'light'}
          onChange={handleChange}
          className="h-full min-h-full flex-1"
        />
      </div>
      {/* 隐藏的本地图片选择输入框 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageFileChange}
      />
    </div>
  );
};

/**
 * 富文本编辑器入口：用 noteId + contentResetKey 作为 key 强制重建核心实例
 * @param props 编辑器属性
 * @returns 富文本编辑器实例
 */
const NoteRichTextEditor: React.FC<NoteRichTextEditorProps> = (props) => {
  const { contentResetKey = 0, noteId, ...rest } = props;
  return (
    <NoteRichTextEditorCore
      key={`${noteId}-${contentResetKey}`}
      noteId={noteId}
      contentResetKey={contentResetKey}
      {...rest}
    />
  );
};

export default NoteRichTextEditor;