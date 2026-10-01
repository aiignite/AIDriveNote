/**
 * NoteMindMapEditor – 基于 Simple Mind Map 的思维导图编辑器
 *
 * 职责：
 * 1. 承载 simple-mind-map 实例，负责数据加载/变更回传（onChange）；
 * 2. 提供增强工具条（节点、历史、样式、插入、视图、布局）；
 * 3. 通过 onRegistryChange 向 NoteEditorPanel 上报命令与菜单组，
 *    使顶部统一菜单栏与命令面板（⌘K）能驱动本编辑器。
 *
 * 注意：本文件是思维导图编辑器对外能力的唯一入口，命令 id 使用
 * edit.* / insert.* / view.* / format.* 与 mindmap.* 命名空间，
 * 不占用面板独占的 file.* / help.* / view.outline / view.fullscreen。
 */
import React, {
  useEffect,
  useRef,
  useCallback,
  useState,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import {
  Plus, GitBranch, MoveUp, Pencil, Trash2,
  Undo2, Redo2, Scissors, Copy, ClipboardPaste,
  PaintBucket, Baseline, Square, Ruler, Shapes,
  Smile, Image, Link2, StickyNote, Tag, Rows3, Spline,
  Maximize2, Minimize2, Focus, ZoomIn, ZoomOut,
  Map, Search, Palette, LayoutGrid, ListTree,
} from 'lucide-react';
import toast from 'react-hot-toast';
import SimpleMindMap from 'simple-mind-map';
// @ts-expect-error no types available
import SelectPlugin from 'simple-mind-map/src/plugins/Select.js';
// @ts-expect-error no types available
import DragPlugin from 'simple-mind-map/src/plugins/Drag.js';
// @ts-expect-error no types available
import ExportPlugin from 'simple-mind-map/src/plugins/Export.js';
// @ts-expect-error no types available
import ExportPDFPlugin from 'simple-mind-map/src/plugins/ExportPDF.js';
// @ts-expect-error no types available
import ExportXMindPlugin from 'simple-mind-map/src/plugins/ExportXMind.js';
// @ts-expect-error no types available
import KeyboardNavigationPlugin from 'simple-mind-map/src/plugins/KeyboardNavigation.js';
// @ts-expect-error no types available
import SearchPlugin from 'simple-mind-map/src/plugins/Search.js';
// @ts-expect-error no types available
import MiniMapPlugin from 'simple-mind-map/src/plugins/MiniMap.js';
// @ts-expect-error no types available
import NodeImgAdjustPlugin from 'simple-mind-map/src/plugins/NodeImgAdjust.js';
// @ts-expect-error no types available
import AssociativeLinePlugin from 'simple-mind-map/src/plugins/AssociativeLine.js';
import type {
  NoteCommand,
  NoteEditorRegistry,
  NoteMenuGroup,
  NoteMenuItem,
} from '../../utils/noteCommands';

// eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook, it's a library static method
SimpleMindMap.usePlugin(SelectPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(DragPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(ExportPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(ExportPDFPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(ExportXMindPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(KeyboardNavigationPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(SearchPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(MiniMapPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(NodeImgAdjustPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(AssociativeLinePlugin);

/** 可切换的布局结构（simple-mind-map 内置 6 种） */
const LAYOUTS = [
  { value: 'logicalStructure', label: '逻辑结构' },
  { value: 'mindMap', label: '思维导图' },
  { value: 'organizationStructure', label: '组织结构' },
  { value: 'catalogOrganization', label: '目录组织' },
  { value: 'timeline', label: '时间线' },
  { value: 'fishbone', label: '鱼骨图' },
];

/** 节点可选形状（取值来自 simple-mind-map 的 shapeList） */
const SHAPES = [
  { value: 'rectangle', label: '矩形' },
  { value: 'roundedRectangle', label: '圆角矩形' },
  { value: 'ellipse', label: '椭圆' },
  { value: 'circle', label: '圆形' },
  { value: 'diamond', label: '菱形' },
  { value: 'parallelogram', label: '平行四边形' },
  { value: 'octagonalRectangle', label: '八边形' },
];

/** 可选字号 */
const FONT_SIZES = [12, 14, 16, 18, 20, 24, 28, 32];

/** 展开层级候选项 */
const EXPAND_LEVELS = [1, 2, 3, 4];

/** 节点图标面板（非富文本模式下以文本形式渲染） */
const ICON_LIST = ['⭐', '✅', '❗', '❓', '📌', '💡', '🚩', '🎯', '❤️', '🔥', '⚠️', '📝'];

/** 样式色板 */
const COLOR_PALETTE = [
  '#ffffff', '#000000', '#f5222d', '#fa541c',
  '#fa8c16', '#fadb14', '#52c41a', '#13c2c2',
  '#1677ff', '#722ed1', '#eb2f96', '#8c8c8c',
];

/** 主题候选项（dark/classic/blue 由本文件静态注册） */
const THEME_OPTIONS = [
  { value: 'default', label: '默认' },
  { value: 'dark', label: '暗色' },
  { value: 'classic', label: '经典' },
  { value: 'blue', label: '蓝色' },
];

/** 暗色主题覆盖项（内部会与 default 主题深合并） */
const DARK_THEME_CONFIG = {
  backgroundColor: '#1f2937',
  lineColor: '#6b7280',
  root: { fillColor: '#374151', color: '#f9fafb' },
  second: { fillColor: '#4b5563', color: '#f3f4f6' },
  node: { fillColor: '#374151', color: '#e5e7eb' },
  generalization: { fillColor: '#4b5563', color: '#e5e7eb' },
};

/** 经典主题覆盖项 */
const CLASSIC_THEME_CONFIG = {
  backgroundColor: '#fdf6e3',
  lineColor: '#b58900',
  root: { fillColor: '#d33682', color: '#ffffff' },
  second: { fillColor: '#eee8d5', color: '#586e75', borderColor: '#b58900' },
  node: { fillColor: 'transparent', color: '#657b83', borderColor: '#93a1a1' },
};

/** 蓝色主题覆盖项 */
const BLUE_THEME_CONFIG = {
  backgroundColor: '#eff6ff',
  lineColor: '#3b82f6',
  root: { fillColor: '#2563eb', color: '#ffffff' },
  second: { fillColor: '#dbeafe', color: '#1e3a8a', borderColor: '#60a5fa' },
  node: { fillColor: 'transparent', color: '#1e40af', borderColor: '#93c5fd' },
};

/** 主题是否已注册（模块级只执行一次，兼容 HMR 重复执行） */
let themesRegistered = false;

/**
 * 注册自定义主题（仅覆盖必要字段，内部与 default 主题合并）。
 * 说明：simple-mind-map 的 src/theme/index.js 只内置 default，
 * 因此必须通过静态方法 defineTheme 注册后才能 setTheme 生效。
 */
function registerThemes() {
  if (themesRegistered) return;
  try {
    SimpleMindMap.defineTheme('dark', DARK_THEME_CONFIG);
    SimpleMindMap.defineTheme('classic', CLASSIC_THEME_CONFIG);
    SimpleMindMap.defineTheme('blue', BLUE_THEME_CONFIG);
  } catch {
    /* 主题已存在时忽略 */
  }
  themesRegistered = true;
}

registerThemes();

/**
 * 读取思维导图实例当前激活的节点列表。
 * 说明：实例上的渲染对象是 mindMap.renderer（非 render），无 getActiveNode 方法。
 * @param mindMap 思维导图实例
 * @returns 激活节点数组（无则为空数组）
 */
function getActiveNodes(mindMap: any): any[] {
  const list = mindMap?.renderer?.activeNodeList;
  return Array.isArray(list) ? list : [];
}

/** 生成单条命令（统一补全 isEnabled 兜底，避免菜单里出现不可执行的项） */
function createCommand(command: NoteCommand): NoteCommand {
  return command;
}

interface NoteMindMapEditorProps {
  /** 笔记 id，用于判断是否切换了笔记 */
  noteId: string;
  /** 笔记内容（思维导图节点树数据） */
  content?: Record<string, unknown>;
  /** 内容重置键，外部（AI 刷新）自增时强制重载内容 */
  contentResetKey?: number;
  /** 内容变更回调（回传节点树数据） */
  onChange?: (content: Record<string, unknown>) => void;
  /** 节点点击回调 */
  onNodeClick?: (nodeData: Record<string, unknown>) => void;
  /** 只读模式 */
  readOnly?: boolean;
  /** 暗色模式 */
  isDark?: boolean;
  /** 初始布局 */
  defaultLayout?: string;
  /** 向面板上报可用命令与菜单组 */
  onRegistryChange?: (registry: NoteEditorRegistry) => void;
}

export interface NoteMindMapEditorHandle {
  /** 导出指定格式（'png' | 'svg' | 'pdf' | 'json' | 'xmind' 等），返回数据内容 */
  export: (format: string, isDownload?: boolean) => Promise<string | null | undefined>;
}

const NoteMindMapEditor = forwardRef<NoteMindMapEditorHandle, NoteMindMapEditorProps>(({
  noteId,
  content,
  contentResetKey = 0,
  onChange,
  onNodeClick,
  readOnly = false,
  isDark = false,
  defaultLayout,
  onRegistryChange,
}, ref) => {
  /* ---------- 实例与状态引用 ---------- */
  /** 思维导图挂载容器 */
  const containerRef = useRef<HTMLDivElement>(null);
  /** 思维导图实例（any：库未提供完整类型） */
  const mindMapRef = useRef<any>(null);
  /** onChange 最新引用，避免实例事件闭包过期 */
  const onChangeRef = useRef(onChange);
  /** 是否忽略 data_change（初始化 / setData 期间） */
  const ignoreChangeRef = useRef(true);
  /** 上一次回传内容的字符串快照，用于去重 */
  const lastValueRef = useRef('');
  /** 上一次的 noteId，用于判断是否切换笔记 */
  const prevNoteIdRef = useRef(noteId);
  /** 上一次的 contentResetKey，用于判断是否需要强制重载 */
  const lastResetKeyRef = useRef(contentResetKey);
  /** onNodeClick 最新引用 */
  const onNodeClickRef = useRef(onNodeClick);
  /** 小地图开关的镜像 ref（供 isChecked 读取，保证 registry 引用稳定） */
  const miniMapOnRef = useRef(false);
  /** 主题名镜像 ref（供 isChecked 读取） */
  const themeNameRef = useRef(isDark ? 'dark' : 'default');
  /** 小地图容器 */
  const miniMapBoxRef = useRef<HTMLDivElement>(null);
  /** 导入 JSON 的隐藏文件输入 */
  const importInputRef = useRef<HTMLInputElement>(null);
  /** 插入本地图片的隐藏文件输入 */
  const imageInputRef = useRef<HTMLInputElement>(null);
  /** 搜索输入框 */
  const searchInputRef = useRef<HTMLInputElement>(null);

  /** 当前布局 */
  const [layout, setLayout] = useState(defaultLayout || 'logicalStructure');
  /** 是否存在激活节点（驱动工具栏禁用态） */
  const [hasActiveNode, setHasActiveNode] = useState(false);
  /** 小地图是否开启 */
  const [miniMapOn, setMiniMapOn] = useState(false);
  /** 当前主题 */
  const [themeName, setThemeName] = useState(isDark ? 'dark' : 'default');
  /** 当前打开的样式下拉（null 表示全部关闭） */
  const [openPalette, setOpenPalette] = useState<null | 'fill' | 'color' | 'border' | 'line' | 'icon'>(null);
  /** 搜索关键词 */
  const [searchText, setSearchText] = useState('');

  onChangeRef.current = onChange;
  onNodeClickRef.current = onNodeClick;
  miniMapOnRef.current = miniMapOn;
  themeNameRef.current = themeName;

  /* ---------- 对外句柄：导出（NoteEditorPanel 依赖它导出 PNG 到 PDF） ---------- */
  useImperativeHandle(ref, () => ({
    export: async (format: string, isDownload = true) => {
      if (!mindMapRef.current) return null;
      return mindMapRef.current.export(format, isDownload);
    },
  }), []);

  /* ---------- 实例初始化 ---------- */
  useEffect(() => {
    if (!containerRef.current) return;

    const defaultData = content || {
      data: { text: '中心主题' },
      children: [],
    };

    const mindMap = new SimpleMindMap({
      el: containerRef.current,
      data: defaultData,
      readonly: readOnly,
      layout: defaultLayout || 'logicalStructure',
    } as any);

    mindMapRef.current = mindMap;
    ignoreChangeRef.current = true;

    // 内容变更：回传节点树数据给父级
    mindMap.on('data_change', (data: any) => {
      if (ignoreChangeRef.current) return;
      if (!data) return;
      const newContent = JSON.stringify(data);
      if (newContent !== lastValueRef.current) {
        lastValueRef.current = newContent;
        onChangeRef.current?.(data);
      }
    });

    // 节点激活：更新工具栏禁用态，并在单选时回传节点数据
    mindMap.on('node_active', (_node: any, activeNodeList: any[]) => {
      setHasActiveNode(activeNodeList && activeNodeList.length > 0);
      if (activeNodeList && activeNodeList.length === 1) {
        const nodeData = activeNodeList[0]?.nodeData?.data;
        if (nodeData && onNodeClickRef.current) {
          onNodeClickRef.current(nodeData);
        }
      }
    });

    // 延迟开启变更监听，避开初始化的多次 data_change 事件
    setTimeout(() => {
      ignoreChangeRef.current = false;
      // 初始化后适应画布
      mindMap.view?.reset?.();
    }, 1000);

    return () => {
      mindMap.destroy();
      mindMapRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---------- 切换笔记或 AI 刷新：setData 而非整实例重建 ---------- */
  useEffect(() => {
    if (!mindMapRef.current) return;

    const data = content || {
      data: { text: '中心主题' },
      children: [],
    };
    const contentId = JSON.stringify(data);
    const noteChanged = prevNoteIdRef.current !== noteId;
    const resetChanged = lastResetKeyRef.current !== contentResetKey;
    prevNoteIdRef.current = noteId;
    lastResetKeyRef.current = contentResetKey;

    if (!noteChanged && !resetChanged && contentId === lastValueRef.current) return;
    lastValueRef.current = contentId;

    ignoreChangeRef.current = true;
    mindMapRef.current.setData(data);
    mindMapRef.current.view?.reset?.();
    window.setTimeout(() => {
      ignoreChangeRef.current = false;
    }, 800);
  }, [noteId, content, contentResetKey]);

  /* ---------- 主题：isDark 变化时切换到暗色/默认 ---------- */
  useEffect(() => {
    setThemeName(isDark ? 'dark' : 'default');
  }, [isDark]);

  /* ---------- 主题应用 ---------- */
  useEffect(() => {
    mindMapRef.current?.setTheme(themeName);
  }, [themeName]);

  /* ---------- 小地图渲染与交互 ---------- */
  useEffect(() => {
    if (!miniMapOn) return undefined;
    const mm = mindMapRef.current;
    const box = miniMapBoxRef.current;
    if (!mm || !box) return undefined;

    /** 小地图容器尺寸 */
    const BOX_W = 200;
    const BOX_H = 140;
    let raf = 0;

    /** 依据插件返回的数据重绘小地图内容 */
    const draw = () => {
      try {
        const res = mm.miniMap?.calculationMiniMap(BOX_W, BOX_H);
        if (!res) return;
        box.innerHTML = `<div style="position:relative;width:100%;height:100%;overflow:hidden;">${res.svgHTML}<div class="smm-mini-map-view-box" style="position:absolute;box-sizing:border-box;border:1px solid #409eff;background:rgba(64,158,255,0.18);pointer-events:auto;cursor:move;left:${res.viewBoxStyle.left};top:${res.viewBoxStyle.top};right:${res.viewBoxStyle.right};bottom:${res.viewBoxStyle.bottom};"></div></div>`;
        const svgEl = box.querySelector('svg');
        if (svgEl) {
          // 依据 svg 自身坐标系算出等比缩放后的实际尺寸与位置，与插件视口框算法保持一致
          const vb = (svgEl.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
          const naturalW = vb[2] || BOX_W;
          const naturalH = vb[3] || BOX_H;
          const ratio = naturalH > 0 ? naturalW / naturalH : 1;
          let actW: number;
          let actH: number;
          if (BOX_W / BOX_H > ratio) {
            actH = BOX_H;
            actW = ratio * actH;
          } else {
            actW = BOX_W;
            actH = actW / ratio;
          }
          const el = svgEl;
          el.style.position = 'absolute';
          el.style.left = `${res.miniMapBoxLeft}px`;
          el.style.top = `${res.miniMapBoxTop}px`;
          el.style.width = `${actW}px`;
          el.style.height = `${actH}px`;
        }
        const viewBox = box.querySelector('.smm-mini-map-view-box');
        viewBox?.addEventListener('mousedown', (e) => {
          e.stopPropagation();
          mm.miniMap.onViewBoxMousedown(e);
        });
        viewBox?.addEventListener('mousemove', (e) => {
          mm.miniMap.onViewBoxMousemove(e);
        });
      } catch {
        /* 小地图绘制失败时静默忽略，不影响主画布 */
      }
    };

    /** 合并同一帧内的多次重绘请求 */
    const schedule = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(draw);
    };

    /** 容器鼠标按下：整体拖动画布 */
    const onMousedown = (e: MouseEvent) => mm.miniMap?.onMousedown(e);
    /** 容器鼠标移动：拖动画布 */
    const onMousemove = (e: MouseEvent) => mm.miniMap?.onMousemove(e);
    /** 全局鼠标松开：复位拖拽状态 */
    const onMouseup = () => mm.miniMap?.onMouseup();

    mm.on('data_change', schedule);
    mm.on('view_data_change', schedule);
    box.addEventListener('mousedown', onMousedown);
    box.addEventListener('mousemove', onMousemove);
    window.addEventListener('mouseup', onMouseup);
    schedule();

    return () => {
      window.cancelAnimationFrame(raf);
      mm.off('data_change', schedule);
      mm.off('view_data_change', schedule);
      box.removeEventListener('mousedown', onMousedown);
      box.removeEventListener('mousemove', onMousemove);
      window.removeEventListener('mouseup', onMouseup);
    };
  }, [miniMapOn]);

  /* ---------- 样式下拉的点击外部关闭 ---------- */
  useEffect(() => {
    if (!openPalette) return undefined;
    const close = () => setOpenPalette(null);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [openPalette]);

  /* ---------- 节点操作 ---------- */
  /** 添加子节点 */
  const addChild = useCallback(() => {
    mindMapRef.current?.execCommand('INSERT_CHILD_NODE');
  }, []);
  /** 添加兄弟节点 */
  const addSibling = useCallback(() => {
    mindMapRef.current?.execCommand('INSERT_NODE');
  }, []);
  /** 添加父节点 */
  const addParent = useCallback(() => {
    mindMapRef.current?.execCommand('INSERT_PARENT_NODE');
  }, []);
  /** 删除当前激活节点 */
  const deleteNode = useCallback(() => {
    mindMapRef.current?.execCommand('REMOVE_NODE');
  }, []);
  /** 进入节点文本编辑态（库以 node_dblclick 事件触发编辑框） */
  const editText = useCallback(() => {
    const mm = mindMapRef.current;
    const node = getActiveNodes(mm)[0];
    if (!mm || !node) return;
    mm.emit('node_dblclick', node);
  }, []);

  /* ---------- 历史操作 ---------- */
  /** 撤销 */
  const undo = useCallback(() => {
    mindMapRef.current?.execCommand('BACK');
  }, []);
  /** 重做 */
  const redo = useCallback(() => {
    mindMapRef.current?.execCommand('FORWARD');
  }, []);
  /** 剪切 */
  const cut = useCallback(() => {
    mindMapRef.current?.renderer?.cut();
  }, []);
  /** 复制 */
  const copy = useCallback(() => {
    mindMapRef.current?.renderer?.copy();
  }, []);
  /** 粘贴 */
  const paste = useCallback(() => {
    void mindMapRef.current?.renderer?.paste();
  }, []);
  /** 全选 */
  const selectAll = useCallback(() => {
    mindMapRef.current?.execCommand('SELECT_ALL');
  }, []);

  /* ---------- 样式操作 ---------- */
  /**
   * 为所有激活节点设置单个样式属性。
   * @param prop 样式属性名（fillColor / color / borderColor / fontSize / lineColor 等）
   * @param value 样式值
   */
  const applyNodeStyle = useCallback((prop: string, value: string | number) => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0) return;
    nodes.forEach((node) => mm.execCommand('SET_NODE_STYLE', node, prop, value));
  }, []);
  /**
   * 为所有激活节点设置形状。
   * @param shape shapeList 中的形状值
   */
  const applyNodeShape = useCallback((shape: string) => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0) return;
    nodes.forEach((node) => mm.execCommand('SET_NODE_SHAPE', node, shape));
  }, []);

  /* ---------- 插入操作 ---------- */
  /**
   * 为激活节点设置图标（图标以数组形式存储）。
   * @param icon 单个 emoji 字符
   */
  const applyIcon = useCallback((icon: string) => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0) return;
    nodes.forEach((node) => mm.execCommand('SET_NODE_ICON', node, [icon]));
  }, []);
  /**
   * 把图片地址应用到激活节点，读取原图尺寸以保证比例正确。
   * @param url 图片地址（网络地址或 dataURL）
   */
  const applyImageUrl = useCallback((url: string) => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0 || !url) return;
    const setImage = (width: number, height: number) => {
      nodes.forEach((node) => mm.execCommand('SET_NODE_IMAGE', node, {
        url,
        title: '',
        width,
        height,
        custom: false,
      }));
    };
    const img = new window.Image();
    img.onload = () => setImage(img.naturalWidth || 100, img.naturalHeight || 100);
    img.onerror = () => setImage(100, 100);
    img.src = url;
  }, []);
  /** 插入图片：优先提示输入地址，留空则选择本地图片 */
  const insertImage = useCallback(() => {
    const mm = mindMapRef.current;
    if (!mm || getActiveNodes(mm).length === 0) return;
    const url = window.prompt('图片地址（留空可选择本地图片）');
    if (url === null) return;
    if (url.trim()) {
      applyImageUrl(url.trim());
      return;
    }
    imageInputRef.current?.click();
  }, [applyImageUrl]);
  /** 本地图片选择完成：读取为 dataURL 后插入 */
  const handleImageFile = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => applyImageUrl(String(reader.result || ''));
    reader.readAsDataURL(file);
  }, [applyImageUrl]);
  /** 插入超链接 */
  const insertHyperlink = useCallback(() => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0) return;
    const url = window.prompt('请输入链接地址');
    if (url === null) return;
    const link = url.trim();
    if (!link) return;
    nodes.forEach((node) => mm.execCommand('SET_NODE_HYPERLINK', node, link, link));
  }, []);
  /** 插入备注 */
  const insertNote = useCallback(() => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0) return;
    const note = window.prompt('请输入备注内容');
    if (note === null) return;
    nodes.forEach((node) => mm.execCommand('SET_NODE_NOTE', node, note));
  }, []);
  /** 插入标签 */
  const insertTag = useCallback(() => {
    const mm = mindMapRef.current;
    const nodes = getActiveNodes(mm);
    if (!mm || nodes.length === 0) return;
    const tag = window.prompt('请输入标签内容');
    if (tag === null) return;
    nodes.forEach((node) => mm.execCommand('SET_NODE_TAG', node, tag));
  }, []);
  /** 插入概要（需先选中多个节点） */
  const insertGeneralization = useCallback(() => {
    mindMapRef.current?.execCommand('ADD_GENERALIZATION');
  }, []);
  /** 从当前节点创建关联线（需再次点击目标节点完成连线） */
  const insertAssociativeLine = useCallback(() => {
    mindMapRef.current?.associativeLine?.createLineFromActiveNode();
  }, []);

  /* ---------- 视图操作 ---------- */
  /** 展开全部 */
  const expandAll = useCallback(() => {
    mindMapRef.current?.execCommand('EXPAND_ALL');
  }, []);
  /** 折叠全部 */
  const collapseAll = useCallback(() => {
    mindMapRef.current?.execCommand('UNEXPAND_ALL');
  }, []);
  /**
   * 展开到指定层级（命令 UNEXPAND_TO_LEVEL 内部同时处理展开与折叠）。
   * @param level 目标层级（1-4）
   */
  const expandToLevel = useCallback((level: number) => {
    mindMapRef.current?.execCommand('UNEXPAND_TO_LEVEL', level);
  }, []);
  /** 适应画布 */
  const fitView = useCallback(() => {
    mindMapRef.current?.view?.reset();
  }, []);
  /** 放大 */
  const zoomIn = useCallback(() => {
    const view = mindMapRef.current?.view;
    if (!view) return;
    view.setScale((view.scale || 1) + 0.1);
  }, []);
  /** 缩小 */
  const zoomOut = useCallback(() => {
    const view = mindMapRef.current?.view;
    if (!view) return;
    view.setScale(Math.max(0.2, (view.scale || 1) - 0.1));
  }, []);
  /** 切换小地图 */
  const toggleMiniMap = useCallback(() => {
    setMiniMapOn((v) => !v);
  }, []);

  /* ---------- 搜索 ---------- */
  /** 执行搜索（Enter 下一个匹配项） */
  const searchNext = useCallback(() => {
    const mm = mindMapRef.current;
    if (!mm?.search) return;
    const text = searchInputRef.current?.value ?? '';
    if (!text) {
      mm.search.endSearch();
      return;
    }
    mm.search.search(text);
  }, []);
  /** 跳到上一个匹配项（插件无 searchPrev，用 jump(index-1) 实现） */
  const searchPrev = useCallback(() => {
    const mm = mindMapRef.current;
    if (!mm?.search) return;
    const text = searchInputRef.current?.value ?? '';
    if (!text) {
      mm.search.endSearch();
      return;
    }
    const total = mm.search.matchNodeList?.length || 0;
    if (!mm.search.isSearching || mm.search.searchText !== text || total <= 0) {
      mm.search.search(text);
      return;
    }
    const prevIndex = mm.search.currentIndex - 1 < 0 ? total - 1 : mm.search.currentIndex - 1;
    mm.search.jump(prevIndex);
  }, []);
  /** 结束搜索并清空关键词 */
  const endSearch = useCallback(() => {
    mindMapRef.current?.search?.endSearch();
    setSearchText('');
  }, []);

  /* ---------- 主题 / 布局 ---------- */
  /** 切换主题 */
  const changeTheme = useCallback((name: string) => {
    setThemeName(name);
  }, []);
  /** 切换布局 */
  const changeLayout = useCallback((l: string) => {
    setLayout(l);
    mindMapRef.current?.setLayout(l);
  }, []);

  /* ---------- 导入 ---------- */
  /** 触发导入文件选择 */
  const importJson = useCallback(() => {
    importInputRef.current?.click();
  }, []);
  /** 导入文件：支持 .json / .smm（含 root 的完整数据或纯节点树） */
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    const mm = mindMapRef.current;
    if (!file || !mm) return;
    let parsed: any;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast.error('文件解析失败：不是合法的 JSON');
      return;
    }
    try {
      if (parsed && parsed.root) {
        // 导出的完整数据（含布局/主题/视图），使用 setFullData
        mm.setFullData(parsed);
      } else if (parsed && parsed.data) {
        // 纯节点树
        mm.setData(parsed);
      } else {
        toast.error('文件格式不受支持');
        return;
      }
      mm.view?.reset?.();
      toast.success('导入成功');
    } catch {
      toast.error('导入失败：数据结构无法识别');
    }
  }, []);

  /* ---------- 导出（仅注册为命令，供命令面板搜索；工具条不放） ---------- */
  /**
   * 导出并触发下载。
   * @param format 导出格式
   * @param fileName 文件名（不含扩展名）
   */
  const handleExport = useCallback(async (format: string, fileName: string) => {
    const mm = mindMapRef.current;
    if (!mm) return;
    try {
      const res = await mm.export(format, false, fileName);
      if (!res) {
        toast.error('导出失败');
        return;
      }
      const a = document.createElement('a');
      a.href = typeof res === 'string' ? res : URL.createObjectURL(res as Blob);
      a.download = `${fileName}.${format}`;
      a.click();
      if (typeof res !== 'string') URL.revokeObjectURL(a.href);
    } catch {
      toast.error('导出失败');
    }
  }, []);

  /* ---------- 命令表 ---------- */
  const commands = useMemo<NoteCommand[]>(() => {
    /** 是否有激活节点 */
    const hasNodes = () => getActiveNodes(mindMapRef.current).length > 0;
    /** 是否可撤销 */
    const canUndo = () => {
      const cmd = mindMapRef.current?.command;
      return !!cmd && cmd.activeHistoryIndex > 0;
    };
    /** 是否可重做 */
    const canRedo = () => {
      const cmd = mindMapRef.current?.command;
      return !!cmd && cmd.activeHistoryIndex < cmd.history.length - 1;
    };

    const list: NoteCommand[] = [
      /* 编辑 */
      createCommand({ id: 'edit.undo', label: '撤销', shortcut: 'Mod+Z', keywords: 'undo back', run: undo, isEnabled: () => !readOnly && canUndo() }),
      createCommand({ id: 'edit.redo', label: '重做', shortcut: 'Mod+Shift+Z', keywords: 'redo forward', run: redo, isEnabled: () => !readOnly && canRedo() }),
      createCommand({ id: 'edit.cut', label: '剪切节点', shortcut: 'Mod+X', run: cut, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'edit.copy', label: '复制节点', shortcut: 'Mod+C', run: copy, isEnabled: () => hasNodes() }),
      createCommand({ id: 'edit.paste', label: '粘贴节点', shortcut: 'Mod+V', run: paste, isEnabled: () => !readOnly }),
      createCommand({ id: 'edit.deleteNode', label: '删除节点', shortcut: 'Del', danger: true, run: deleteNode, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'edit.editText', label: '编辑文本', shortcut: 'Space', keywords: 'edit text', run: editText, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'edit.selectAll', label: '全选', shortcut: 'Mod+A', run: selectAll }),

      /* 插入 */
      createCommand({ id: 'insert.childNode', label: '添加子节点', shortcut: 'Tab', run: addChild, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.siblingNode', label: '添加兄弟节点', shortcut: 'Enter', run: addSibling, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.parentNode', label: '添加父节点', run: addParent, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.icon', label: '插入图标', keywords: 'icon emoji', run: () => setOpenPalette('icon'), isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.image', label: '插入图片', keywords: 'image picture', run: insertImage, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.hyperlink', label: '插入超链接', keywords: 'link url', run: insertHyperlink, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.note', label: '插入备注', keywords: 'note remark', run: insertNote, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.tag', label: '插入标签', keywords: 'tag label', run: insertTag, isEnabled: () => !readOnly && hasNodes() }),
      createCommand({ id: 'insert.generalization', label: '添加概要', keywords: 'generalization summary', run: insertGeneralization, isEnabled: () => !readOnly && getActiveNodes(mindMapRef.current).length > 1 }),
      createCommand({ id: 'insert.associativeLine', label: '添加关联线', keywords: 'associative line', run: insertAssociativeLine, isEnabled: () => !readOnly && hasNodes() }),

      /* 视图 */
      createCommand({ id: 'view.expandAll', label: '展开全部', run: expandAll }),
      createCommand({ id: 'view.collapseAll', label: '折叠全部', run: collapseAll }),
      createCommand({ id: 'view.fitView', label: '适应画布', keywords: 'fit reset', run: fitView }),
      createCommand({ id: 'view.zoomIn', label: '放大', shortcut: 'Mod+=', run: zoomIn }),
      createCommand({ id: 'view.zoomOut', label: '缩小', shortcut: 'Mod+-', run: zoomOut }),
      createCommand({ id: 'view.minimap', label: '小地图', keywords: 'minimap map', run: toggleMiniMap, isChecked: () => miniMapOnRef.current }),
      createCommand({ id: 'view.search', label: '搜索节点', shortcut: 'Mod+F', keywords: 'search find', run: () => searchInputRef.current?.focus() }),
    ];

    // 展开到层级
    EXPAND_LEVELS.forEach((level) => {
      list.push(createCommand({
        id: `view.expandToLevel.${level}`,
        label: `展开到 ${level} 级`,
        run: () => expandToLevel(level),
      }));
    });

    // 主题
    THEME_OPTIONS.forEach((theme) => {
      list.push(createCommand({
        id: `view.theme.${theme.value}`,
        label: `主题：${theme.label}`,
        run: () => changeTheme(theme.value),
        isChecked: () => themeNameRef.current === theme.value,
      }));
    });

    // 填充色 / 字体色 / 边框色 / 连线色
    COLOR_PALETTE.forEach((color) => {
      const key = color.replace('#', '');
      list.push(createCommand({ id: `format.fillColor.${key}`, label: `填充色 ${color}`, run: () => applyNodeStyle('fillColor', color), isEnabled: hasNodes }));
      list.push(createCommand({ id: `format.textColor.${key}`, label: `字体色 ${color}`, run: () => applyNodeStyle('color', color), isEnabled: hasNodes }));
      list.push(createCommand({ id: `format.borderColor.${key}`, label: `边框色 ${color}`, run: () => applyNodeStyle('borderColor', color), isEnabled: hasNodes }));
      list.push(createCommand({ id: `format.lineColor.${key}`, label: `连线色 ${color}`, run: () => applyNodeStyle('lineColor', color), isEnabled: hasNodes }));
    });

    // 字号
    FONT_SIZES.forEach((size) => {
      list.push(createCommand({
        id: `format.fontSize.${size}`,
        label: `字号 ${size}`,
        run: () => applyNodeStyle('fontSize', size),
        isEnabled: hasNodes,
      }));
    });

    // 形状
    SHAPES.forEach((shape) => {
      list.push(createCommand({
        id: `format.shape.${shape.value}`,
        label: `形状：${shape.label}`,
        run: () => applyNodeShape(shape.value),
        isEnabled: hasNodes,
      }));
    });

    // 图标
    ICON_LIST.forEach((icon, index) => {
      list.push(createCommand({
        id: `insert.icon.${index}`,
        label: `图标 ${icon}`,
        run: () => applyIcon(icon),
        isEnabled: hasNodes,
      }));
    });

    /* 文件操作：仅进入命令面板搜索，不放进任何菜单组（file.* 归面板所有） */
    list.push(createCommand({ id: 'mindmap.import', label: '导入思维导图', keywords: 'import json smm', run: importJson }));
    list.push(createCommand({ id: 'mindmap.export.png', label: '导出为 PNG', keywords: 'export png image', run: () => handleExport('png', `mindmap_${Date.now()}`) }));
    list.push(createCommand({ id: 'mindmap.export.json', label: '导出为 JSON', keywords: 'export json', run: () => handleExport('json', `mindmap_${Date.now()}`) }));
    list.push(createCommand({ id: 'mindmap.export.pdf', label: '导出为 PDF', keywords: 'export pdf', run: () => handleExport('pdf', `mindmap_${Date.now()}`) }));
    list.push(createCommand({ id: 'mindmap.export.xmind', label: '导出为 XMind', keywords: 'export xmind', run: () => handleExport('xmind', `mindmap_${Date.now()}`) }));

    return list;
  }, [
    undo, redo, cut, copy, paste, deleteNode, editText, selectAll,
    addChild, addSibling, addParent, insertImage, insertHyperlink, insertNote,
    insertTag, insertGeneralization, insertAssociativeLine,
    expandAll, collapseAll, expandToLevel, fitView, zoomIn, zoomOut, toggleMiniMap,
    changeTheme, applyNodeStyle, applyNodeShape, applyIcon,
    importJson, handleExport, readOnly,
  ]);

  /* ---------- 菜单组 ---------- */
  const groups = useMemo<NoteMenuGroup[]>(() => {
    /** 生成颜色子菜单项 */
    const colorItems = (commandIdPrefix: string): NoteMenuItem[] => COLOR_PALETTE.map((color) => ({
      commandId: `${commandIdPrefix}.${color.replace('#', '')}`,
    }));

    const editGroup: NoteMenuGroup = {
      id: 'edit',
      items: [
        { commandId: 'edit.undo' },
        { commandId: 'edit.redo' },
        { commandId: 'edit.cut', separatorBefore: true },
        { commandId: 'edit.copy' },
        { commandId: 'edit.paste' },
        { commandId: 'edit.deleteNode', separatorBefore: true },
        { commandId: 'edit.editText' },
        { commandId: 'edit.selectAll', separatorBefore: true },
      ],
    };

    const insertGroup: NoteMenuGroup = {
      id: 'insert',
      items: [
        { commandId: 'insert.childNode' },
        { commandId: 'insert.siblingNode' },
        { commandId: 'insert.parentNode' },
        { commandId: 'insert.icon', separatorBefore: true },
        { commandId: 'insert.image' },
        { commandId: 'insert.hyperlink' },
        { commandId: 'insert.note' },
        { commandId: 'insert.tag' },
        { commandId: 'insert.generalization', separatorBefore: true },
        { commandId: 'insert.associativeLine' },
      ],
    };

    const formatGroup: NoteMenuGroup = {
      id: 'format',
      items: [
        { labelOverride: '填充色', children: colorItems('format.fillColor') },
        { labelOverride: '字体色', children: colorItems('format.textColor') },
        { labelOverride: '边框色', children: colorItems('format.borderColor') },
        { labelOverride: '连线色', children: colorItems('format.lineColor') },
        {
          labelOverride: '字号',
          separatorBefore: true,
          children: FONT_SIZES.map((size) => ({ commandId: `format.fontSize.${size}` })),
        },
        {
          labelOverride: '形状',
          separatorBefore: true,
          children: SHAPES.map((shape) => ({ commandId: `format.shape.${shape.value}` })),
        },
      ],
    };

    const viewGroup: NoteMenuGroup = {
      id: 'view',
      items: [
        { commandId: 'view.expandAll' },
        { commandId: 'view.collapseAll' },
        {
          labelOverride: '展开到层级',
          children: EXPAND_LEVELS.map((level) => ({ commandId: `view.expandToLevel.${level}` })),
        },
        { commandId: 'view.fitView', separatorBefore: true },
        { commandId: 'view.zoomIn' },
        { commandId: 'view.zoomOut' },
        { commandId: 'view.minimap', separatorBefore: true },
        { commandId: 'view.search' },
        {
          labelOverride: '主题',
          separatorBefore: true,
          children: THEME_OPTIONS.map((theme) => ({ commandId: `view.theme.${theme.value}` })),
        },
      ],
    };

    return [editGroup, insertGroup, formatGroup, viewGroup];
  }, []);

  /** 上报 registry（命令表与菜单组引用稳定，避免面板频繁重建） */
  useEffect(() => {
    onRegistryChange?.({ commands, groups });
  }, [commands, groups, onRegistryChange]);

  /* ---------- 工具栏样式 ---------- */
  const btnCls = `p-1.5 rounded-lg transition-colors ${
    isDark
      ? 'text-gray-300 hover:bg-gray-600 hover:text-white'
      : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900'
  }`;
  const btnDisabledCls = `p-1.5 rounded-lg opacity-40 cursor-not-allowed ${
    isDark ? 'text-gray-500' : 'text-gray-400'
  }`;
  const sepCls = `w-px h-5 mx-1 ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`;
  const selectCls = `text-xs rounded px-1 py-0.5 border ${
    isDark ? 'bg-gray-700 border-gray-600 text-gray-200' : 'bg-white border-gray-300 text-gray-700'
  }`;
  const panelCls = `absolute z-20 top-full left-0 mt-1 p-2 rounded-lg shadow-lg border grid grid-cols-4 gap-1 ${
    isDark ? 'bg-gray-700 border-gray-600' : 'bg-white border-gray-200'
  }`;

  /** 渲染一个色板下拉 */
  const renderColorPalette = (
    key: 'fill' | 'color' | 'border' | 'line',
    prop: string,
    icon: React.ReactNode,
    title: string,
  ) => (
    <div className="relative flex items-center">
      <button
        className={hasActiveNode ? btnCls : btnDisabledCls}
        title={title}
        disabled={!hasActiveNode}
        onClick={(e) => { e.stopPropagation(); setOpenPalette(openPalette === key ? null : key); }}
      >
        {icon}
      </button>
      {openPalette === key && (
        <div className={panelCls} onClick={(e) => e.stopPropagation()}>
          {COLOR_PALETTE.map((color) => (
            <button
              key={color}
              className="w-5 h-5 rounded border border-gray-300"
              style={{ backgroundColor: color }}
              title={color}
              onClick={() => { applyNodeStyle(prop, color); setOpenPalette(null); }}
            />
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div className={`w-full h-full flex flex-col ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
      {!readOnly && (
        <div className={`flex items-center gap-1 px-3 py-1.5 border-b flex-wrap ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
          {/* 节点操作 */}
          <button onClick={addChild} className={btnCls} title="添加子节点 (Tab)"><Plus size={16} /></button>
          <button onClick={addSibling} className={btnCls} title="添加兄弟节点 (Enter)"><GitBranch size={16} /></button>
          <button
            onClick={addParent}
            className={hasActiveNode ? btnCls : btnDisabledCls}
            title="添加父节点"
            disabled={!hasActiveNode}
          >
            <MoveUp size={16} />
          </button>
          <button
            onClick={editText}
            className={hasActiveNode ? btnCls : btnDisabledCls}
            title="编辑文本"
            disabled={!hasActiveNode}
          >
            <Pencil size={16} />
          </button>
          <button
            onClick={deleteNode}
            className={hasActiveNode ? btnCls : btnDisabledCls}
            title="删除节点 (Del)"
            disabled={!hasActiveNode}
          >
            <Trash2 size={16} />
          </button>

          <div className={sepCls} />

          {/* 历史操作 */}
          <button onClick={undo} className={btnCls} title="撤销 (⌘Z)"><Undo2 size={16} /></button>
          <button onClick={redo} className={btnCls} title="重做 (⌘⇧Z)"><Redo2 size={16} /></button>
          <button onClick={cut} className={hasActiveNode ? btnCls : btnDisabledCls} title="剪切" disabled={!hasActiveNode}><Scissors size={16} /></button>
          <button onClick={copy} className={hasActiveNode ? btnCls : btnDisabledCls} title="复制" disabled={!hasActiveNode}><Copy size={16} /></button>
          <button onClick={paste} className={btnCls} title="粘贴"><ClipboardPaste size={16} /></button>

          <div className={sepCls} />

          {/* 样式 */}
          {renderColorPalette('fill', 'fillColor', <PaintBucket size={16} />, '填充色')}
          {renderColorPalette('color', 'color', <Baseline size={16} />, '字体色')}
          {renderColorPalette('border', 'borderColor', <Square size={16} />, '边框色')}
          {renderColorPalette('line', 'lineColor', <Ruler size={16} />, '连线颜色')}

          {/* 字号 */}
          <select
            className={selectCls}
            title="字号"
            value=""
            disabled={!hasActiveNode}
            onChange={(e) => { if (e.target.value) applyNodeStyle('fontSize', Number(e.target.value)); }}
          >
            <option value="">字号</option>
            {FONT_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
          </select>

          {/* 形状 */}
          <div className="flex items-center gap-1">
            <Shapes size={16} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
            <select
              className={selectCls}
              title="节点形状"
              value=""
              disabled={!hasActiveNode}
              onChange={(e) => { if (e.target.value) applyNodeShape(e.target.value); }}
            >
              <option value="">形状</option>
              {SHAPES.map((shape) => <option key={shape.value} value={shape.value}>{shape.label}</option>)}
            </select>
          </div>

          <div className={sepCls} />

          {/* 插入 */}
          <div className="relative flex items-center">
            <button
              className={hasActiveNode ? btnCls : btnDisabledCls}
              title="插入图标"
              disabled={!hasActiveNode}
              onClick={(e) => { e.stopPropagation(); setOpenPalette(openPalette === 'icon' ? null : 'icon'); }}
            >
              <Smile size={16} />
            </button>
            {openPalette === 'icon' && (
              <div className={panelCls} onClick={(e) => e.stopPropagation()}>
                {ICON_LIST.map((icon) => (
                  <button
                    key={icon}
                    className={`text-base rounded hover:bg-black/10 ${isDark ? 'text-gray-100' : 'text-gray-800'}`}
                    onClick={() => { applyIcon(icon); setOpenPalette(null); }}
                  >
                    {icon}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button onClick={insertImage} className={hasActiveNode ? btnCls : btnDisabledCls} title="插入图片" disabled={!hasActiveNode}><Image size={16} /></button>
          <button onClick={insertHyperlink} className={hasActiveNode ? btnCls : btnDisabledCls} title="插入超链接" disabled={!hasActiveNode}><Link2 size={16} /></button>
          <button onClick={insertNote} className={hasActiveNode ? btnCls : btnDisabledCls} title="插入备注" disabled={!hasActiveNode}><StickyNote size={16} /></button>
          <button onClick={insertTag} className={hasActiveNode ? btnCls : btnDisabledCls} title="插入标签" disabled={!hasActiveNode}><Tag size={16} /></button>
          <button
            onClick={insertGeneralization}
            className={hasActiveNode ? btnCls : btnDisabledCls}
            title="添加概要（需多选节点）"
            disabled={!hasActiveNode}
          >
            <Rows3 size={16} />
          </button>
          <button onClick={insertAssociativeLine} className={hasActiveNode ? btnCls : btnDisabledCls} title="添加关联线" disabled={!hasActiveNode}><Spline size={16} /></button>

          <div className={sepCls} />

          {/* 视图 */}
          <button onClick={expandAll} className={btnCls} title="展开全部"><Maximize2 size={16} /></button>
          <button onClick={collapseAll} className={btnCls} title="折叠全部"><Minimize2 size={16} /></button>
          <div className="flex items-center gap-1">
            <ListTree size={16} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
            <select
              className={selectCls}
              title="展开到层级"
              value=""
              onChange={(e) => { if (e.target.value) expandToLevel(Number(e.target.value)); }}
            >
              <option value="">层级</option>
              {EXPAND_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
            </select>
          </div>
          <button onClick={fitView} className={btnCls} title="适应画布"><Focus size={16} /></button>
          <button onClick={zoomIn} className={btnCls} title="放大"><ZoomIn size={16} /></button>
          <button onClick={zoomOut} className={btnCls} title="缩小"><ZoomOut size={16} /></button>
          <button
            onClick={toggleMiniMap}
            className={miniMapOn ? `${btnCls} ${isDark ? 'bg-gray-600 text-white' : 'bg-gray-200 text-gray-900'}` : btnCls}
            title="小地图"
          >
            <Map size={16} />
          </button>

          {/* 搜索框 */}
          <div className={`flex items-center gap-1 px-1.5 rounded-lg border ${isDark ? 'border-gray-600' : 'border-gray-300'}`}>
            <Search size={14} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
            <input
              ref={searchInputRef}
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  if (e.shiftKey) searchPrev();
                  else searchNext();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  endSearch();
                }
              }}
              placeholder="搜索节点"
              className={`w-24 bg-transparent text-xs outline-none py-0.5 ${isDark ? 'text-gray-200 placeholder-gray-500' : 'text-gray-700 placeholder-gray-400'}`}
            />
          </div>

          {/* 主题 */}
          <div className="flex items-center gap-1">
            <Palette size={16} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
            <select
              className={selectCls}
              title="主题"
              value={themeName}
              onChange={(e) => changeTheme(e.target.value)}
            >
              {THEME_OPTIONS.map((theme) => <option key={theme.value} value={theme.value}>{theme.label}</option>)}
            </select>
          </div>

          <div className={sepCls} />

          {/* 布局 */}
          <div className="relative flex items-center gap-1">
            <LayoutGrid size={16} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
            <select
              value={layout}
              onChange={(e) => changeLayout(e.target.value)}
              className={selectCls}
              title="布局"
            >
              {LAYOUTS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      <div className="flex-1 w-full relative overflow-hidden">
        <div ref={containerRef} className="w-full h-full" />
        {/* 小地图：仅在小地图开启时渲染 */}
        {miniMapOn && (
          <div
            ref={miniMapBoxRef}
            className={`absolute top-2 right-2 rounded-lg border shadow-sm overflow-hidden pointer-events-auto ${
              isDark ? 'border-gray-600 bg-gray-700' : 'border-gray-300 bg-white'
            }`}
            style={{ width: 200, height: 140 }}
          />
        )}
      </div>

      {/* 隐藏的导入 / 图片选择输入 */}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,.smm,application/json"
        className="hidden"
        onChange={handleImportFile}
      />
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageFile}
      />
    </div>
  );
});

NoteMindMapEditor.displayName = 'NoteMindMapEditor';

export default NoteMindMapEditor;