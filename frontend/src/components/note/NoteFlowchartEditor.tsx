/**
 * NoteFlowchartEditor – 基于 Drawio (embed.diagrams.net) 的流程图编辑器
 * 参照 AIIgniteNote DrawioEditor 风格。
 *
 * 通过 iframe + postMessage(JSON) 与 drawio embed 协议通信，额外提供：
 * - 自有的包装工具条（保存 / 导出 / 导入 / 模板 / 全屏 / 重试）；
 * - 向统一顶部菜单栏与命令面板注册命令（NoteEditorRegistry）；
 * - 模块级 exportActiveFlowchart，供 noteExport.ts 动态调用完成图片导出落地。
 */
import React, { useEffect, useRef, useCallback, useMemo, useState } from 'react';
import { saveAs } from 'file-saver';
import { useIsTouchDevice } from '../../hooks/useMobile';
import type {
  NoteCommand,
  NoteMenuGroup,
  NoteEditorRegistry,
} from '../../utils/noteCommands';

/**
 * 组件属性
 */
interface NoteFlowchartEditorProps {
  /** 笔记 id，切换时触发内容重载 */
  noteId: string;
  /** 当前流程图 XML 内容 */
  content?: string;
  /** 内容重置标记（AI 刷新等），变化时强制重载 */
  contentResetKey?: number;
  /** 内容变化回调（autosave / save 时回写） */
  onChange?: (content: string) => void;
  /** 只读模式：改用 viewer.diagrams.net 只读渲染 */
  readOnly?: boolean;
  /** 深色模式 */
  isDark?: boolean;
  /** 向容器上报本编辑器的命令与菜单注册表 */
  onRegistryChange?: (registry: NoteEditorRegistry) => void;
}

/** drawio embed 编辑器基础地址 */
const DRAWIO_BASE_URL = 'https://embed.diagrams.net/?embed=1&spin=1&proto=json&configure=1';

/**
 * 构造 drawio embed 编辑器地址。
 *
 * 触摸设备追加 touch=1（强制触摸模式界面）与 android=1（强制 Android 触摸
 * 手势：单指平移、双指缩放），避免「请求桌面版网站」等场景下 UA 被识别为
 * 桌面端、drawio 完全禁用触摸手势，导致画布无法缩放与移动。
 * @param touch 是否触摸设备
 * @returns 带触摸参数的 drawio embed 地址
 */
function buildDrawioUrl(touch: boolean): string {
  return touch ? `${DRAWIO_BASE_URL}&touch=1&android=1` : DRAWIO_BASE_URL;
}

/** 加载超时时间（毫秒） */
const LOAD_TIMEOUT = 10000;

/** 导出请求超时时间（毫秒） */
const EXPORT_TIMEOUT = 15000;

/** 默认流程图 XML（无内容时使用） */
const DEFAULT_XML = `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="开始" style="rounded=1;whiteSpace=wrap;" vertex="1" parent="1">
      <mxGeometry x="200" y="40" width="120" height="40" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="处理" style="whiteSpace=wrap;" vertex="1" parent="1">
      <mxGeometry x="200" y="120" width="120" height="40" as="geometry"/>
    </mxCell>
    <mxCell id="4" style="" edge="1" source="2" target="3" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;

/** 当前挂载的流程图编辑器实例的导出实现（模块级单例，供 noteExport 调用） */
let activeExport: ((format: string) => Promise<string | null>) | null = null;

/** 当前挂载实例的最新 XML 镜像（模块级，供 exportActiveFlowchart('xml') 同步返回） */
let activeXml: string | null = null;

/**
 * 构造 drawio configure 配置对象。
 * @param isDark 是否深色模式
 * @returns drawio embed 的 config 字段
 */
function buildDrawioConfig(isDark: boolean): Record<string, unknown> {
  return {
    darkMode: isDark,
    defaultFonts: ['Helvetica', 'Verdana', 'Times New Roman', 'Garamond'],
    noSaveBtn: false,
    saveAndExit: false,
    compressXml: true,
    libraries: 'general',
    defaultLibraries: 'general',
    enableCsp: false,
  };
}

/**
 * 导出当前挂载的流程图（供 noteExport.ts 动态 import 调用）。
 * @param format 'png' | 'svg' | 'xml' | 'pdf'
 * @returns 导出结果（png/svg 为 dataURI 字符串，xml 为 xml 字符串，pdf 为 dataURI 或回退的 svg 字符串；失败为 null）
 */
export async function exportActiveFlowchart(
  format: 'png' | 'svg' | 'xml' | 'pdf',
): Promise<string | null> {
  // XML 直接返回本地镜像内容，不请求 drawio
  if (format === 'xml') return activeXml || DEFAULT_XML;
  if (!activeExport) return null;

  const result = await activeExport(format);
  if (result) return result;

  // 部分 drawio 版本不支持直接导出 pdf，退化为 svg 交由调用方处理
  if (format === 'pdf') return activeExport('svg');
  return null;
}

const NoteFlowchartEditor: React.FC<NoteFlowchartEditorProps> = ({
  noteId,
  content,
  contentResetKey = 0,
  onChange,
  readOnly = false,
  isDark = false,
  onRegistryChange,
}) => {
  /** iframe 引用（编辑态 / 只读态共用） */
  const iframeRef = useRef<HTMLIFrameElement>(null);
  /** 外层容器引用（全屏目标） */
  const containerRef = useRef<HTMLDivElement>(null);
  /** 隐藏的文件导入 input */
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** 编辑器是否已就绪（init 已到达） */
  const [ready, setReady] = useState(false);
  /** 是否已加载超时 */
  const [timedOut, setTimedOut] = useState(false);
  /** 是否处于离线状态 */
  const [offline, setOffline] = useState(
    () => typeof navigator !== 'undefined' && navigator.onLine === false,
  );
  /** 是否处于全屏状态 */
  const [isFullscreen, setIsFullscreen] = useState(false);
  /** 重试计数：变化时重挂 iframe 并重置加载态 */
  const [retryKey, setRetryKey] = useState(0);
  /** 工具条「导出」菜单是否展开（点击切换，兼容触摸屏） */
  const [showExportMenu, setShowExportMenu] = useState(false);
  /** 触摸设备：决定 drawio embed 是否启用触摸手势参数 */
  const isTouch = useIsTouchDevice();

  /** 导出菜单容器引用（用于点击外部关闭） */
  const exportMenuRef = useRef<HTMLDivElement>(null);

  /** 最新内容镜像（handler 内读取，避免监听重建） */
  const contentRef = useRef(content);
  /** 最新 isDark 镜像 */
  const isDarkRef = useRef(isDark);
  /** 最新 onChange 镜像 */
  const onChangeRef = useRef(onChange);
  /** 最新 ready 镜像（命令 isEnabled 读取） */
  const readyRef = useRef(false);
  /** 上一次笔记 id（用于判断切换重载） */
  const prevNoteIdRef = useRef(noteId);
  /** 上一次内容重置标记 */
  const lastResetKeyRef = useRef(contentResetKey);
  /** 上一次 isDark（用于单独触发 configure 重发） */
  const prevDarkRef = useRef(isDark);
  /** 待处理的导出请求（含超时定时器） */
  const pendingExportRef = useRef<{
    format: string;
    resolve: (value: string | null) => void;
    timer: number;
  } | null>(null);

  contentRef.current = content;

  useEffect(() => { activeXml = content ?? null; }, [content]);
  useEffect(() => { isDarkRef.current = isDark; }, [isDark]);
  useEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useEffect(() => { readyRef.current = ready; }, [ready]);

  // 点击导出菜单外部时关闭（触摸屏无 hover，需依赖点击切换 + 外部关闭）
  useEffect(() => {
    /** 全局 mousedown 监听：点击菜单容器外即收起 */
    const onOutside = (e: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    document.addEventListener('mousedown', onOutside);
    return () => document.removeEventListener('mousedown', onOutside);
  }, []);

  /** 向 iframe 发送 postMessage(JSON) */
  const postMessage = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
  }, []);

  /**
   * 向 drawio 发起导出请求，并等待其回传 export 事件。
   * @param format 导出格式（png / svg / pdf / xml）
   * @returns 回传数据；超时或未挂载时返回 null
   */
  const requestExport = useCallback((format: string): Promise<string | null> => {
    // 若已有未消解的请求，先以 null 结束，避免悬挂
    if (pendingExportRef.current) {
      window.clearTimeout(pendingExportRef.current.timer);
      pendingExportRef.current.resolve(null);
      pendingExportRef.current = null;
    }
    return new Promise<string | null>((resolve) => {
      const timer = window.setTimeout(() => {
        if (pendingExportRef.current?.timer === timer) pendingExportRef.current = null;
        resolve(null);
      }, EXPORT_TIMEOUT);
      pendingExportRef.current = { format, resolve, timer };
      // 兼容部分 drawio 版本：export 时一并携带当前 xml
      postMessage({ action: 'export', format, xml: contentRef.current || DEFAULT_XML });
    });
  }, [postMessage]);

  /** 把导出结果落地为文件 */
  const downloadResult = useCallback(async (format: 'png' | 'svg' | 'pdf' | 'xml', data: string | null) => {
    if (!data) return;
    const base = `flowchart_${Date.now()}`;
    if (format === 'xml') {
      saveAs(new Blob([data], { type: 'application/xml;charset=utf-8' }), `${base}.xml`);
      return;
    }
    // pdf 回退结果可能是 svg 文本，而非 dataURI
    if (format === 'pdf' && !data.startsWith('data:')) {
      saveAs(new Blob([data], { type: 'image/svg+xml;charset=utf-8' }), `${base}.svg`);
      return;
    }
    const link = document.createElement('a');
    link.href = data;
    link.download = `${base}.${format}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, []);

  /* ────── drawio 消息处理（依赖收敛为 [postMessage]，其余经 ref 读取最新值） ────── */
  useEffect(() => {
    const handler = (evt: MessageEvent) => {
      if (!evt.data || typeof evt.data !== 'string') return;
      let msg: any;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }

      switch (msg.event) {
        case 'configure':
          postMessage({ action: 'configure', config: buildDrawioConfig(isDarkRef.current) });
          break;
        case 'init':
          setReady(true);
          postMessage({ action: 'load', xml: contentRef.current || DEFAULT_XML, autosave: 1 });
          break;
        case 'autosave':
          if (typeof msg.xml === 'string') {
            activeXml = msg.xml;
            onChangeRef.current?.(msg.xml);
          }
          break;
        case 'save':
          if (typeof msg.xml === 'string') {
            activeXml = msg.xml;
            contentRef.current = msg.xml;
            onChangeRef.current?.(msg.xml);
          }
          // 告诉 drawio 保存完毕
          postMessage({ action: 'status', modified: false });
          break;
        case 'export': {
          // drawio 回传 { event:'export', format, data }（xml 时字段为 xml）
          const payload = (msg.data ?? msg.xml ?? null) as string | null;
          const pending = pendingExportRef.current;
          if (pending) {
            window.clearTimeout(pending.timer);
            pendingExportRef.current = null;
            pending.resolve(typeof payload === 'string' ? payload : null);
          }
          break;
        }
        case 'prompt': {
          // drawio 弹输入框，必须回传消解，否则会卡死
          const value = window.prompt(msg.title || '请输入', msg.value || '');
          if (value === null) postMessage({ action: 'prompt', value: null, cancel: true });
          else postMessage({ action: 'prompt', value });
          break;
        }
        case 'dialog':
          // drawio 请求宿主弹窗：当前无需处理，也不回传以免干扰
          break;
        case 'template':
        case 'exit':
          if (typeof msg.xml === 'string' && msg.xml) {
            activeXml = msg.xml;
            onChangeRef.current?.(msg.xml);
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [postMessage]);

  /* ────── 挂载 / 卸载时注册模块级导出实现 ────── */
  useEffect(() => {
    if (readOnly) return;
    const impl = (format: string) => requestExport(format);
    activeExport = impl;
    return () => {
      // 仅当仍是自己的实现时才清空，避免覆盖后来实例
      if (activeExport === impl) activeExport = null;
    };
  }, [readOnly, requestExport]);

  /* ────── isDark 变化：单独重发 configure 并重载，避免重建事件监听 ────── */
  useEffect(() => {
    if (prevDarkRef.current === isDark) return;
    prevDarkRef.current = isDark;
    if (!readyRef.current) return;
    postMessage({ action: 'configure', config: buildDrawioConfig(isDark) });
    postMessage({ action: 'load', xml: contentRef.current || DEFAULT_XML, autosave: 1 });
  }, [isDark, postMessage]);

  /* ────── 切换笔记或 AI 刷新时重新加载 XML ────── */
  useEffect(() => {
    if (!ready) return;
    const noteChanged = prevNoteIdRef.current !== noteId;
    const resetChanged = lastResetKeyRef.current !== contentResetKey;
    prevNoteIdRef.current = noteId;
    lastResetKeyRef.current = contentResetKey;
    if (!noteChanged && !resetChanged && content === contentRef.current) return;
    contentRef.current = content;
    postMessage({ action: 'load', xml: content || DEFAULT_XML, autosave: 1 });
  }, [ready, noteId, content, contentResetKey, postMessage]);

  /* ────── 重试：重置加载态并统计超时 ────── */
  useEffect(() => {
    setReady(false);
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), LOAD_TIMEOUT);
    return () => clearTimeout(timer);
  }, [retryKey]);

  /* ────── 在线 / 离线状态监听 ────── */
  useEffect(() => {
    const onOnline = () => setOffline(false);
    const onOffline = () => setOffline(true);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  /* ────── 全屏状态监听 ────── */
  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  /* ────── 工具条 / 命令共用的行为 ────── */
  /** 保存 */
  const handleSave = useCallback(() => { postMessage({ action: 'save' }); }, [postMessage]);
  /** 触发隐藏的文件选择框 */
  const handleImportClick = useCallback(() => { fileInputRef.current?.click(); }, []);
  /** 读取导入的 XML 并加载 */
  const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    activeXml = text;
    contentRef.current = text;
    postMessage({ action: 'load', xml: text, autosave: 1 });
    onChangeRef.current?.(text);
    e.target.value = '';
  }, [postMessage]);
  /** 打开 drawio 模板对话框 */
  const handleTemplate = useCallback(() => {
    postMessage({ action: 'dialog', dialog: 'template' });
  }, [postMessage]);
  /** 重试加载 */
  const handleRetry = useCallback(() => { setRetryKey(k => k + 1); }, []);
  /** 切换全屏 */
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void containerRef.current?.requestFullscreen();
  }, []);
  /** 导出并落地 */
  const handleExport = useCallback(async (format: 'png' | 'svg' | 'pdf' | 'xml') => {
    setShowExportMenu(false);
    const data = await exportActiveFlowchart(format);
    await downloadResult(format, data);
  }, [downloadResult]);

  /* ────── 命令与菜单注册（引用稳定，供面板合并渲染） ────── */
  const commands = useMemo<NoteCommand[]>(() => [
    { id: 'flowchart.save', label: '保存流程图', keywords: 'save 保存', run: handleSave, isEnabled: () => readyRef.current },
    { id: 'flowchart.export.png', label: '导出为 PNG', keywords: 'export png image 导出 图片', run: () => handleExport('png'), isEnabled: () => readyRef.current },
    { id: 'flowchart.export.svg', label: '导出为 SVG', keywords: 'export svg 导出 矢量', run: () => handleExport('svg'), isEnabled: () => readyRef.current },
    { id: 'flowchart.export.pdf', label: '导出为 PDF', keywords: 'export pdf 导出', run: () => handleExport('pdf'), isEnabled: () => readyRef.current },
    { id: 'flowchart.export.xml', label: '导出为 XML', keywords: 'export xml source 导出 源码', run: () => handleExport('xml'), isEnabled: () => readyRef.current },
    { id: 'flowchart.import', label: '导入 XML', keywords: 'import 导入 打开', run: handleImportClick, isEnabled: () => readyRef.current },
    { id: 'flowchart.template', label: '插入模板', keywords: 'template 模板', run: handleTemplate, isEnabled: () => readyRef.current },
    { id: 'flowchart.retry', label: '重新加载流程图', keywords: 'retry reload 重试 重新加载', run: handleRetry, isEnabled: () => readyRef.current },
    { id: 'flowchart.fullscreen', label: '全屏', keywords: 'fullscreen 全屏', run: toggleFullscreen, isEnabled: () => readyRef.current },
  ], [handleSave, handleExport, handleImportClick, handleTemplate, handleRetry, toggleFullscreen]);

  const groups = useMemo<NoteMenuGroup[]>(() => [
    {
      id: 'view',
      items: [
        { commandId: 'flowchart.save' },
        { commandId: 'flowchart.import' },
        { commandId: 'flowchart.template' },
        { commandId: 'flowchart.export.png', separatorBefore: true },
        { commandId: 'flowchart.export.svg' },
        { commandId: 'flowchart.export.pdf' },
        { commandId: 'flowchart.export.xml' },
        { commandId: 'flowchart.retry', separatorBefore: true },
        { commandId: 'flowchart.fullscreen' },
      ],
    },
  ], []);

  const registry = useMemo<NoteEditorRegistry>(() => ({ commands, groups }), [commands, groups]);

  useEffect(() => { onRegistryChange?.(registry); }, [registry, onRegistryChange]);

  /* ────── 只读模式：使用 viewer.diagrams.net ────── */
  if (readOnly && content) {
    return (
      <div className={`w-full h-full ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
        <iframe
          ref={iframeRef}
          src={`https://viewer.diagrams.net/?highlight=0000ff&nav=1&dark=${isDark ? '1' : '0'}#R${encodeURIComponent(content)}`}
          className="w-full h-full border-0"
          title="Flowchart Viewer"
        />
      </div>
    );
  }

  const toolbarBtn = `px-2 py-1 text-xs rounded-md transition-colors ${
    isDark ? 'text-gray-200 hover:bg-gray-700' : 'text-gray-700 hover:bg-gray-200'
  }`;

  return (
    <div
      ref={containerRef}
      className={`w-full h-full flex flex-col ${isDark ? 'bg-gray-800' : 'bg-white'}`}
    >
      {/* 自有工具条（放在 iframe 之上，避免与 drawio 内部 UI 冲突） */}
      {!readOnly && (
        <div className={`flex flex-wrap items-center gap-1 px-2 py-1 border-b ${isDark ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-gray-50'}`}>
          <button type="button" className={toolbarBtn} onClick={handleSave}>保存</button>
          <div ref={exportMenuRef} className="relative">
            <button type="button" className={toolbarBtn} onClick={() => setShowExportMenu(v => !v)}>导出 ▾</button>
            {showExportMenu && (
              <div className={`flex flex-col absolute left-0 top-full z-30 min-w-[96px] py-1 rounded-md shadow-lg border ${isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'}`}>
                <button type="button" className={`${toolbarBtn} text-left`} onClick={() => handleExport('png')}>PNG</button>
                <button type="button" className={`${toolbarBtn} text-left`} onClick={() => handleExport('svg')}>SVG</button>
                <button type="button" className={`${toolbarBtn} text-left`} onClick={() => handleExport('pdf')}>PDF</button>
                <button type="button" className={`${toolbarBtn} text-left`} onClick={() => handleExport('xml')}>XML</button>
              </div>
            )}
          </div>
          <button type="button" className={toolbarBtn} onClick={handleImportClick}>导入</button>
          <button type="button" className={toolbarBtn} onClick={handleTemplate}>模板</button>
          <button type="button" className={toolbarBtn} onClick={toggleFullscreen}>{isFullscreen ? '退出全屏' : '全屏'}</button>
          <button type="button" className={toolbarBtn} onClick={handleRetry}>重试</button>
          <span className={`ml-auto text-xs ${ready ? 'text-green-500' : isDark ? 'text-gray-400' : 'text-gray-500'}`}>
            {ready ? '已就绪' : '加载中'}
          </span>
        </div>
      )}

      <div className="relative flex-1 min-h-0">
        {/* 加载中遮罩（离线时不展示，直接展示离线提示） */}
        {!ready && !timedOut && !offline && (
          <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
            <div className="w-10 h-10 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>正在加载流程图编辑器…</p>
          </div>
        )}
        {/* 离线提示 */}
        {offline && !ready && (
          <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              无法加载流程图编辑器（Draw.io 需联网加载），请检查网络后重试。富文本 / Markdown / 思维导图在离线状态下仍可正常使用。
            </p>
            <button
              onClick={handleRetry}
              className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
            >
              重试
            </button>
          </div>
        )}
        {/* 超时重试提示 */}
        {timedOut && !ready && !offline && (
          <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
              无法加载流程图编辑器（Draw.io 需联网加载），请检查网络后重试。富文本 / Markdown / 思维导图在离线状态下仍可正常使用。
            </p>
            <button
              onClick={handleRetry}
              className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
            >
              重试
            </button>
          </div>
        )}
        <iframe
          key={retryKey}
          ref={iframeRef}
          src={buildDrawioUrl(isTouch)}
          className="w-full h-full border-0"
          title="Drawio Editor"
        />
      </div>

      {/* 隐藏的导入文件选择框 */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".xml,.drawio,application/xml,text/xml"
        className="hidden"
        onChange={handleImportFile}
      />
    </div>
  );
};

export default NoteFlowchartEditor;