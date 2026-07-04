/**
 * NoteMindMapEditor – 基于 Simple Mind Map 的思维导图编辑器
 * 参照 AIIgniteNote/MindMapEditor 的正确实现
 */
import React, { useEffect, useRef, useCallback, useState, forwardRef, useImperativeHandle } from 'react';
import {
  Plus, GitBranch, Maximize2, Minimize2, ZoomIn, ZoomOut,
  Trash2, Download, Focus, LayoutGrid, Image,
} from 'lucide-react';
import SimpleMindMap from 'simple-mind-map';
// @ts-expect-error no types available
import SelectPlugin from 'simple-mind-map/src/plugins/Select.js';
// @ts-expect-error no types available
import DragPlugin from 'simple-mind-map/src/plugins/Drag.js';
// @ts-expect-error no types available
import ExportPlugin from 'simple-mind-map/src/plugins/Export.js';

// eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook, it's a library static method
SimpleMindMap.usePlugin(SelectPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(DragPlugin);
// eslint-disable-next-line react-hooks/rules-of-hooks
SimpleMindMap.usePlugin(ExportPlugin);

const LAYOUTS = [
  { value: 'logicalStructure', label: '逻辑结构' },
  { value: 'mindMap', label: '思维导图' },
  { value: 'organizationStructure', label: '组织结构' },
  { value: 'catalogOrganization', label: '目录组织' },
  { value: 'timeline', label: '时间线' },
  { value: 'fishbone', label: '鱼骨图' },
];

interface NoteMindMapEditorProps {
  noteId: string;
  content?: Record<string, unknown>;
  contentResetKey?: number;
  onChange?: (content: Record<string, unknown>) => void;
  onNodeClick?: (nodeData: Record<string, unknown>) => void;
  readOnly?: boolean;
  isDark?: boolean;
  defaultLayout?: string;
}

export interface NoteMindMapEditorHandle {
  export: (format: string) => Promise<string | null | undefined>;
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
}, ref) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const mindMapRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);
  const ignoreChangeRef = useRef(true);
  const lastValueRef = useRef('');
  const prevNoteIdRef = useRef(noteId);
  const lastResetKeyRef = useRef(contentResetKey);
  const [layout, setLayout] = useState(defaultLayout || 'logicalStructure');
  const [hasActiveNode, setHasActiveNode] = useState(false);

  onChangeRef.current = onChange;
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  useImperativeHandle(ref, () => ({
    export: async (format: string) => {
      if (!mindMapRef.current) return null;
      return mindMapRef.current.export(format);
    },
  }), []);

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

    mindMap.on('data_change', (data: any) => {
      if (ignoreChangeRef.current) return;
      if (!data) return;
      const newContent = JSON.stringify(data);
      if (newContent !== lastValueRef.current) {
        lastValueRef.current = newContent;
        onChangeRef.current?.(data);
      }
    });

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

  // 切换笔记或 AI 刷新：setData 而非整实例重建
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

  useEffect(() => {
    if (mindMapRef.current) {
      mindMapRef.current.setTheme(isDark ? 'dark' : 'default');
    }
  }, [isDark]);

  /* ---------- 节点操作 ---------- */
  const addChild = useCallback(() => {
    mindMapRef.current?.execCommand('INSERT_CHILD_NODE');
  }, []);
  const addSibling = useCallback(() => {
    mindMapRef.current?.execCommand('INSERT_NODE');
  }, []);
  const deleteNode = useCallback(() => {
    mindMapRef.current?.execCommand('REMOVE_NODE');
  }, []);

  /* ---------- 视图 ---------- */
  const expandAll = useCallback(() => {
    mindMapRef.current?.execCommand('EXPAND_ALL');
  }, []);
  const collapseAll = useCallback(() => {
    mindMapRef.current?.execCommand('UNEXPAND_ALL');
  }, []);
  const fitView = useCallback(() => {
    mindMapRef.current?.view?.reset();
  }, []);
  const zoomIn = useCallback(() => {
    const s = mindMapRef.current?.view?.scale || 1;
    mindMapRef.current?.view?.setScale(s + 0.1);
  }, []);
  const zoomOut = useCallback(() => {
    const s = mindMapRef.current?.view?.scale || 1;
    mindMapRef.current?.view?.setScale(Math.max(0.2, s - 0.1));
  }, []);

  /* ---------- 布局切换 ---------- */
  const changeLayout = useCallback((l: string) => {
    setLayout(l);
    mindMapRef.current?.setLayout(l);
  }, []);

  /* ---------- 导出 ---------- */
  const exportPNG = useCallback(async () => {
    try {
      const dataUrl = await mindMapRef.current?.export('png');
      if (!dataUrl) return;
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `mindmap_${Date.now()}.png`;
      a.click();
    } catch { /* ignore */ }
  }, []);
  const exportJSON = useCallback(() => {
    const data = mindMapRef.current?.getData(true);
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `mindmap_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }, []);

  /* ---------- 样式 ---------- */
  const btnCls = `p-1.5 rounded-lg transition-colors ${
    isDark
      ? 'text-gray-300 hover:bg-gray-600 hover:text-white'
      : 'text-gray-600 hover:bg-gray-200 hover:text-gray-900'
  }`;
  const btnDisabledCls = `p-1.5 rounded-lg opacity-40 cursor-not-allowed ${
    isDark ? 'text-gray-500' : 'text-gray-400'
  }`;
  const sepCls = `w-px h-5 mx-1 ${isDark ? 'bg-gray-600' : 'bg-gray-300'}`;

  return (
    <div className={`w-full h-full flex flex-col ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
      {!readOnly && (
        <div className={`flex items-center gap-1 px-3 py-1.5 border-b flex-wrap ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`}>
          {/* 节点操作 */}
          <button onClick={addChild} className={btnCls} title="添加子节点">
            <Plus size={16} />
          </button>
          <button onClick={addSibling} className={btnCls} title="添加兄弟节点">
            <GitBranch size={16} />
          </button>
          <button
            onClick={deleteNode}
            className={hasActiveNode ? btnCls : btnDisabledCls}
            title="删除节点"
            disabled={!hasActiveNode}
          >
            <Trash2 size={16} />
          </button>

          <div className={sepCls} />

          {/* 视图 */}
          <button onClick={expandAll} className={btnCls} title="展开全部">
            <Maximize2 size={16} />
          </button>
          <button onClick={collapseAll} className={btnCls} title="折叠全部">
            <Minimize2 size={16} />
          </button>
          <button onClick={fitView} className={btnCls} title="适应画布">
            <Focus size={16} />
          </button>
          <button onClick={zoomIn} className={btnCls} title="放大">
            <ZoomIn size={16} />
          </button>
          <button onClick={zoomOut} className={btnCls} title="缩小">
            <ZoomOut size={16} />
          </button>

          <div className={sepCls} />

          {/* 布局 */}
          <div className="relative flex items-center">
            <button className={`${btnCls} flex items-center gap-1`} title="布局">
              <LayoutGrid size={16} />
            </button>
            <select
              value={layout}
              onChange={(e) => changeLayout(e.target.value)}
              className={`text-xs rounded px-1 py-0.5 border ${
                isDark
                  ? 'bg-gray-700 border-gray-600 text-gray-200'
                  : 'bg-white border-gray-300 text-gray-700'
              }`}
            >
              {LAYOUTS.map((l) => (
                <option key={l.value} value={l.value}>{l.label}</option>
              ))}
            </select>
          </div>

          <div className={sepCls} />

          {/* 导出 */}
          <button onClick={exportPNG} className={btnCls} title="导出 PNG">
            <Image size={16} />
          </button>
          <button onClick={exportJSON} className={btnCls} title="导出 JSON">
            <Download size={16} />
          </button>
        </div>
      )}
      <div ref={containerRef} className="flex-1 w-full relative overflow-hidden" />
    </div>
  );
});

NoteMindMapEditor.displayName = 'NoteMindMapEditor';

export default NoteMindMapEditor;
