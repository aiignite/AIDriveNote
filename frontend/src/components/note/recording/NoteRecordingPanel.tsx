/**
 * NoteRecordingPanel.tsx — 富文本笔记录音 / 转写 / AI 整理浮窗（紧凑版）
 *
 * 由会议版录音能力去会议化整合。面板锚定在工具栏麦克风按钮下方（~320px 宽），
 * 采用「分步两段式」流程：
 *
 *  1. 采集步：只显示「录音」「上传」两个小按钮；
 *  2. 处理步：录音结束后自动展开状态列表与处理按钮（插入 / 重转写 / AI 整理）。
 *
 * 录音期间面板整体隐藏（不遮挡编辑器），仅由工具栏麦克风按钮上的小红点提示；
 * 停止录音后由编辑器自动重新弹出本面板展示处理选项。
 * 面板与录音实例分离：AudioRecorder 常驻挂载，面板收起 / 隐藏不会中断正在进行的录音。
 */
import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PartialBlock } from '@blocknote/core';
import { Mic, Upload, Trash2, X, FileAudio, Loader2, PlusCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNoteRecording } from '../../../hooks/useNoteRecording';
import { noteRecordingApi, resolveAudioUrl, type BrowserTranscriptSegment } from '../../../services/note/recording';
import { transcriptToBlocks, buildAudioBlock } from '../../../utils/noteAudioBlocks';
import { AudioRecorder, type AudioRecorderHandle } from './AudioRecorder';
import { AudioUploader } from './AudioUploader';
import { RecordingStatusBadge } from './RecordingStatusBadge';
import type { RecordingDotState } from './RecordingStatusDot';
import { TranscriptPreview } from './TranscriptPreview';

/** 视口边缘最小留白（像素） */
const VIEWPORT_MARGIN = 8;

/** 面板尺寸持久化键（记录用户拖拽后的宽高，重开时复用） */
const PANEL_SIZE_STORAGE_KEY = 'aidrivenote:recordingPanelSize';

/** 默认面板宽度（像素） */
const DEFAULT_PANEL_WIDTH = 360;

/** 默认面板高度（像素） */
const DEFAULT_PANEL_HEIGHT = 420;

/** 面板最小宽度（像素） */
const MIN_PANEL_WIDTH = 280;

/** 面板最小高度（像素） */
const MIN_PANEL_HEIGHT = 240;

/** 面板最大宽度（像素），避免拖得过宽遮挡编辑器 */
const MAX_PANEL_WIDTH = 720;

/** 面板最大高度上限（像素），实际还会受视口高度约束 */
const MAX_PANEL_HEIGHT = 1000;

/**
 * 读取持久化的面板尺寸。
 * @returns 合法范围内的宽高；无记录或解析失败时返回默认尺寸
 */
function loadPanelSize(): { width: number; height: number } {
  const fallback = { width: DEFAULT_PANEL_WIDTH, height: DEFAULT_PANEL_HEIGHT };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(PANEL_SIZE_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { width?: number; height?: number };
    const width = Number(parsed?.width);
    const height = Number(parsed?.height);
    return {
      width: Number.isFinite(width) ? Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width)) : fallback.width,
      height: Number.isFinite(height) ? Math.max(MIN_PANEL_HEIGHT, Math.min(MAX_PANEL_HEIGHT, height)) : fallback.height,
    };
  } catch {
    return fallback;
  }
}

/**
 * 计算受视口约束的最大面板高度。
 * @returns 面板可用的最大高度（像素）
 */
function viewportMaxHeight(): number {
  if (typeof window === 'undefined') return DEFAULT_PANEL_HEIGHT;
  return Math.max(MIN_PANEL_HEIGHT, window.innerHeight - VIEWPORT_MARGIN * 2);
}

interface NoteRecordingPanelProps {
  /** 是否打开 */
  open: boolean;
  /** 关联笔记 id */
  noteId: string;
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 插入笔记回调：把音频块 + 文本块插入编辑器 */
  onInsert: (blocks: PartialBlock[]) => void;
  /** 锚点元素（工具栏麦克风按钮）；缺省时退化为屏幕右下角定位 */
  anchorRef?: React.RefObject<HTMLElement | null>;
  /** 录音状态标记变化回调（供工具栏麦克风按钮显示小圆点） */
  onStatusChange?: (state: RecordingDotState) => void;
  /** 录音状态变化回调（true=开始 / false=停止），供编辑器感知录音状态并在停止后自动弹出处理面板 */
  onRecordingStateChange?: (recording: boolean) => void;
}

/**
 * 录音浮窗命令式句柄：工具栏麦克风按钮通过它直接驱动录音的开始 / 停止。
 */
export interface NoteRecordingPanelHandle {
  /** 开始录音 */
  start: () => void;
  /** 停止录音 */
  stop: () => void;
  /** 当前已录制时长（毫秒），未录音时为 0 */
  getElapsedMs: () => number;
}

/**
 * 录音浮窗组件。
 *
 * 面板与录音实例分离：面板在「关闭」或「录音中」时整体隐藏，录音实例（AudioRecorder）
 * 常驻挂载，保证收起界面不会中断采集。录音期间仅由工具栏麦克风按钮上的小红点提示。
 *
 * @param props 组件属性
 * @param ref 命令式句柄（start / stop），供工具栏麦克风按钮直接驱动录音
 * @returns 锚定在麦克风按钮下方的紧凑浮窗；隐藏时仅渲染不可见的录音实例宿主
 */
export const NoteRecordingPanel = forwardRef<NoteRecordingPanelHandle, NoteRecordingPanelProps>(
  ({
    open,
    noteId,
    isDark = false,
    onClose,
    onInsert,
    anchorRef,
    onStatusChange,
    onRecordingStateChange,
  }, ref) => {
  const {
    recordings,
    activeRecording,
    transcriptSegments,
    isRecordingsLoading,
    isTranscriptLoading,
    isUploading,
    retranscribingId,
    refiningId,
    error,
    selectRecording,
    uploadRecording,
    retranscribe,
    refine,
    remove,
  } = useNoteRecording(noteId, { enabled: open });

  /** 是否展开拖拽上传区 */
  const [showDropzone, setShowDropzone] = useState(false);
  /** 是否正在录音（录音期间面板整体隐藏） */
  const [isRecording, setIsRecording] = useState(false);
  /** 当前环境是否支持浏览器录音（不支持时降级为上传入口） */
  const [recorderSupported, setRecorderSupported] = useState(true);
  /** 命令式打开文件选择（供录音降级使用） */
  const uploadOpenRef = useRef<(() => void) | null>(null);
  /** 浮窗自身引用 */
  const panelRef = useRef<HTMLDivElement>(null);
  /** 常驻录音实例句柄：录音期间面板布局变化也不会中断采集 */
  const recorderRef = useRef<AudioRecorderHandle>(null);
  /** 面板尺寸（可拖拽调整），初始值从 localStorage 恢复 */
  const [size, setSize] = useState<{ width: number; height: number }>(() => loadPanelSize());
  /** size 的最新值镜像，供拖拽结束时的持久化回调读取 */
  const sizeRef = useRef(size);
  sizeRef.current = size;
  /** 拖拽缩放会话的起始快照（为 null 表示未在拖拽） */
  const resizeStartRef = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  /** onRecordingStateChange 的稳定引用（供 handleRecordingChange 闭包读取最新回调） */
  const onRecordingStateChangeRef = useRef(onRecordingStateChange);
  onRecordingStateChangeRef.current = onRecordingStateChange;

  /**
   * 开始录音。
   * @returns void
   */
  const startRecording = useCallback(() => {
    void recorderRef.current?.start();
  }, []);

  /**
   * 停止录音。
   * @returns void
   */
  const stopRecording = useCallback(() => {
    recorderRef.current?.stop();
  }, []);

  // 暴露命令式句柄：工具栏麦克风按钮直接驱动录音的开始 / 停止
  useImperativeHandle(ref, () => ({
    start: startRecording,
    stop: stopRecording,
    getElapsedMs: () => recorderRef.current?.elapsedMs ?? 0,
  }), [startRecording, stopRecording]);

  /** 当前录音是否正在执行某动作 */
  const busyAction = useMemo<'retranscribe' | 'refine' | null>(() => {
    if (!activeRecording) return null;
    if (retranscribingId === activeRecording.id) return 'retranscribe';
    if (refiningId === activeRecording.id) return 'refine';
    return null;
  }, [activeRecording, retranscribingId, refiningId]);

  /** 聚合状态标记：录音中 > 转写处理中 > 失败 > 已完成 > 空闲 */
  const dotState = useMemo<RecordingDotState>(() => {
    if (isRecording) return 'recording';
    if (busyAction) return 'processing';
    if (recordings.some(r => r.status === 'Uploaded' || r.status === 'Transcribing')) return 'processing';
    if (recordings.some(r => r.status === 'Failed')) return 'failed';
    if (recordings.some(r => r.status === 'Transcribed')) return 'done';
    return 'idle';
  }, [isRecording, busyAction, recordings]);

  // 上报聚合状态（工具栏麦克风按钮的小圆点）
  useEffect(() => {
    onStatusChange?.(dotState);
  }, [dotState, onStatusChange]);

  // ── 定位：锚点下方居中，越界时翻转 / 贴边 ──────────────────────────
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  /**
   * 依据锚点按钮与当前面板尺寸计算浮窗位置，越界时翻转 / 贴边。
   * @returns void
   */
  const computePosition = useCallback(() => {
    // 面板高度受视口约束（拖得过高时自动收紧，避免超出屏幕）
    const height = Math.min(size.height, viewportMaxHeight());
    const width = size.width;
    const anchor = anchorRef?.current;
    if (!anchor) {
      // 无锚点（菜单命令打开）：退回视口右侧中部
      setPosition({
        left: Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
        top: Math.max(VIEWPORT_MARGIN, window.innerHeight / 2 - height / 2),
      });
      return;
    }
    const rect = anchor.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.min(
      Math.max(VIEWPORT_MARGIN, left),
      Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN),
    );
    // 默认在按钮下方；下方空间不足则翻转到上方，最后夹取到视口内
    const estimatedHeight = panelRef.current?.offsetHeight ?? height;
    const below = rect.bottom + 6;
    const above = rect.top - estimatedHeight - 6;
    const preferBelow = below + estimatedHeight <= window.innerHeight - VIEWPORT_MARGIN;
    let top = preferBelow ? below : above;
    top = Math.max(VIEWPORT_MARGIN, Math.min(top, window.innerHeight - estimatedHeight - VIEWPORT_MARGIN));
    setPosition({ left, top });
  }, [anchorRef, size.width, size.height]);

  useLayoutEffect(() => {
    if (!open) return;
    computePosition();
  }, [open, computePosition]);

  // 打开期间跟随滚动 / 缩放重新定位
  useEffect(() => {
    if (!open) return undefined;
    const onViewportChange = () => computePosition();
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open, computePosition]);

  /**
   * 开始拖拽缩放面板（右下角手柄）。
   * 通过 window 上的 pointer 事件跟踪移动，松开时持久化尺寸并重新夹取面板位置。
   * @param e 指针按下事件
   * @returns void
   */
  const handleResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    resizeStartRef.current = { x: e.clientX, y: e.clientY, width: size.width, height: size.height };
    const onMove = (ev: PointerEvent) => {
      const start = resizeStartRef.current;
      if (!start) return;
      const maxHeight = Math.min(MAX_PANEL_HEIGHT, viewportMaxHeight());
      const width = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, start.width + (ev.clientX - start.x)));
      const height = Math.max(MIN_PANEL_HEIGHT, Math.min(maxHeight, start.height + (ev.clientY - start.y)));
      setSize({ width, height });
    };
    const onUp = () => {
      resizeStartRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      try {
        window.localStorage.setItem(PANEL_SIZE_STORAGE_KEY, JSON.stringify(sizeRef.current));
      } catch { /* 忽略持久化失败（隐私模式等） */ }
      // 仅把当前位置夹取回视口内，避免缩放后因重新锚定造成位置“翻转跳动”
      setPosition(prev => {
        if (!prev) return prev;
        const width = sizeRef.current.width;
        const height = Math.min(sizeRef.current.height, viewportMaxHeight());
        const left = Math.max(VIEWPORT_MARGIN, Math.min(prev.left, window.innerWidth - width - VIEWPORT_MARGIN));
        const top = Math.max(VIEWPORT_MARGIN, Math.min(prev.top, window.innerHeight - height - VIEWPORT_MARGIN));
        return { left, top };
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [size.width, size.height]);

  // 打开期间监听 ESC 与「点击外部关闭」；录音中不关闭，避免误触中断采集
  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isRecording) onClose();
    };
    const onPointerDown = (e: MouseEvent) => {
      if (isRecording) return;
      const target = e.target as Node | null;
      if (!target) return;
      const inPanel = panelRef.current?.contains(target);
      const inAnchor = anchorRef?.current?.contains(target);
      if (!inPanel && !inAnchor) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    // 用 capture 捕获，避免被编辑器内部 stopPropagation 吞掉
    document.addEventListener('mousedown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown, true);
    };
  }, [open, isRecording, onClose, anchorRef]);

  // 关闭时复位瞬时交互状态
  useEffect(() => {
    if (open) return;
    setShowDropzone(false);
    setIsRecording(false);
  }, [open]);

  /**
   * 录音状态变化：同步面板形态，并上报外部（停止后由编辑器自动弹出处理面板）。
   * @param recording 是否正在录音
   * @returns void
   */
  const handleRecordingChange = useCallback((recording: boolean) => {
    setIsRecording(recording);
    onRecordingStateChangeRef.current?.(recording);
  }, []);

  /** 录音启动失败提示（内置按钮已隐藏，错误需由面板代为展示） */
  const handleRecorderError = useCallback((message: string) => {
    toast.error(message || '无法访问麦克风');
  }, []);

  /** 是否显示可见面板：关闭或录音中都不显示（录音期间仅保留工具栏按钮上的小红点） */
  const visible = open && !isRecording;

  /**
   * 采集完成：连同浏览器内置 ASR 分段（若有）一起上传。
   * @param blob 录音 Blob
   * @param fileName 合成文件名
   * @param transcript 浏览器 ASR 分段（可为空，为空则走服务端转写）
   * @param durationMs 录音时长（毫秒）
   * @returns void
   */
  const handleCaptured = (
    blob: Blob,
    fileName: string,
    transcript?: BrowserTranscriptSegment[],
    durationMs?: number,
  ) => {
    setIsRecording(false);
    void uploadRecording(blob, fileName, transcript, durationMs);
  };

  /**
   * 选择文件后上传。
   * @param file 音频文件
   * @returns void
   */
  const handleSelected = (file: File) => {
    void uploadRecording(file);
  };

  /**
   * 删除录音（二次确认）。
   * @param id 录音 id
   * @param name 文件名
   * @returns void
   */
  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`确认删除录音「${name}」及其转写？`)) return;
    const target = recordings.find(r => r.id === id);
    if (target) await remove(target);
  };

  /**
   * 把当前录音的音频块 + 转写文本块插入笔记。
   * @returns void
   */
  const handleInsert = () => {
    if (!activeRecording) return;
    // 优先使用后端算好的 audioUrl（含 HMAC 签名），缺失时用 buildAudioUrl 兜底；
    // resolveAudioUrl 会按 API_BASE 修正子路径部署下的相对地址前缀。
    const audioUrl = resolveAudioUrl(activeRecording.audioUrl, activeRecording.id);
    const blocks: PartialBlock[] = [
      buildAudioBlock(audioUrl, activeRecording.fileName),
      ...transcriptToBlocks(transcriptSegments),
    ];
    onInsert(blocks);
    toast.success('已插入笔记');
    onClose();
  };

  /** 浮窗外壳样式 */
  const shellCls = `fixed z-[70] rounded-xl border shadow-2xl overflow-hidden ${
    isDark ? 'bg-gray-900 text-gray-100 border-gray-700' : 'bg-white text-gray-900 border-gray-200'
  }`;
  /** 次级按钮样式 */
  const ghostBtnCls = `inline-flex items-center justify-center font-medium rounded-lg border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
    isDark
      ? 'border-gray-600 text-gray-300 hover:bg-gray-700'
      : 'border-gray-200 text-gray-600 hover:bg-gray-100'
  }`;

  return (
    <>
      {visible && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="录音转写"
          style={{
            left: position?.left ?? VIEWPORT_MARGIN,
            top: position?.top ?? VIEWPORT_MARGIN,
            width: size.width,
            height: Math.min(size.height, viewportMaxHeight()),
          }}
          className={`${shellCls} flex flex-col`}
        >
          <div className={`flex items-center justify-between px-3 py-2 border-b shrink-0 ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
            <div className="flex items-center gap-1.5">
              <Mic size={13} className="text-rose-500" />
              <h3 className="text-xs font-semibold">录音转写</h3>
              {recordings.length > 0 && (
                <span className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>({recordings.length})</span>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className={`p-1 rounded-md ${isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-400 hover:text-gray-700'}`}
              title="关闭"
              aria-label="关闭"
            >
              <X size={13} />
            </button>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2.5">
        {/* 第一步：采集 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {recorderSupported ? (
            <button
              type="button"
              onClick={startRecording}
              disabled={isUploading}
              title="开始录音"
              aria-label="开始录音"
              className="inline-flex items-center justify-center p-2 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 disabled:opacity-50 shadow-sm"
            >
              <Mic size={14} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => uploadOpenRef.current?.()}
              title={typeof window !== 'undefined' && !window.isSecureContext
                ? 'HTTP 环境无法浏览器录音，请上传音频或改用 HTTPS'
                : '当前浏览器不支持录音，请上传音频'}
              aria-label="上传音频"
              className="inline-flex items-center justify-center p-2 rounded-lg bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200 shadow-sm"
            >
              <Upload size={14} />
            </button>
          )}
          <AudioUploader
            variant="compact"
            iconOnly
            disabled={isUploading}
            onSelected={handleSelected}
            openRef={uploadOpenRef}
          />
          <button
            type="button"
            onClick={() => setShowDropzone(v => !v)}
            disabled={isUploading}
            title={showDropzone ? '收起拖拽上传区' : '展开拖拽上传区'}
            className={`${ghostBtnCls} p-2`}
          >
            <Upload size={14} />
          </button>
          <span className="ml-auto text-[10px] text-gray-400">
            {isUploading ? '上传中…' : '录音或上传音频'}
          </span>
        </div>
        {showDropzone && <AudioUploader disabled={isUploading} onSelected={handleSelected} />}
        {isUploading && (
          <p className="text-[11px] text-sky-600 flex items-center gap-1">
            <Loader2 size={11} className="animate-spin" /> 上传中…
          </p>
        )}

        {/* 错误提示 */}
        {error && <p className="text-[11px] text-rose-600 break-all">{error}</p>}

        {/* 第二步：录音列表 + 处理 */}
        {recordings.length > 0 && (
          <div className="space-y-1 pt-1 border-t border-dashed border-gray-200 dark:border-gray-700">
            <div className="flex items-center justify-between pt-1">
              <p className={`text-[10px] font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                录音列表
              </p>
              {isRecordingsLoading && <Loader2 size={11} className="animate-spin text-gray-400" />}
            </div>
            {recordings.map(rec => (
              <button
                key={rec.id}
                type="button"
                onClick={() => void selectRecording(rec)}
                className={`w-full text-left p-1.5 rounded-lg border transition-colors ${
                  activeRecording?.id === rec.id
                    ? (isDark ? 'border-sky-500 bg-sky-900/20' : 'border-sky-400 bg-sky-50')
                    : (isDark ? 'border-gray-700 hover:bg-gray-800' : 'border-gray-100 hover:bg-gray-50')
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] truncate">
                    <FileAudio size={11} className="shrink-0 text-gray-400" />
                    <span className="truncate">{rec.fileName}</span>
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => { e.stopPropagation(); void handleDelete(rec.id, rec.fileName); }}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void handleDelete(rec.id, rec.fileName); } }}
                    className="shrink-0 text-gray-400 hover:text-rose-500"
                    title="删除录音"
                  >
                    <Trash2 size={11} />
                  </span>
                </div>
                <div className="mt-0.5">
                  <RecordingStatusBadge status={rec.status} progressPct={rec.progressPct} errorMessage={rec.errorMessage} />
                </div>
              </button>
            ))}
          </div>
        )}

        {/* 当前录音的转写与处理 */}
        {activeRecording && (
          <div className={`p-2 space-y-1.5 rounded-lg border ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50/60'}`}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold truncate">{activeRecording.fileName}</span>
              <RecordingStatusBadge status={activeRecording.status} progressPct={activeRecording.progressPct} />
            </div>
            {/* 音频试听（audioUrl 缺失时用 buildAudioUrl 兜底） */}
            <audio
              controls
              preload="metadata"
              src={resolveAudioUrl(activeRecording.audioUrl, activeRecording.id)}
              className="w-full h-8"
            />
            {isTranscriptLoading ? (
              <p className="text-[11px] text-gray-400 flex items-center gap-1">
                <Loader2 size={11} className="animate-spin" /> 加载转写…
              </p>
            ) : activeRecording.status === 'Transcribed' ? (
              <TranscriptPreview
                segments={transcriptSegments}
                isDark={isDark}
                busyAction={busyAction}
                onAiOrganize={() => void refine(activeRecording)}
                onRetranscribe={() => void retranscribe(activeRecording)}
              />
            ) : (
              <p className={`text-[11px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {activeRecording.status === 'Failed' ? '转写失败' : '转写处理中…'}
              </p>
            )}
          </div>
        )}

        {recordings.length === 0 && !isRecordingsLoading && (
          <p className={`text-[11px] text-center py-2 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            暂无录音
          </p>
        )}
      </div>

      {/* 底部：插入笔记 */}
      <div className={`px-3 pr-5 py-2 border-t flex items-center justify-between gap-2 shrink-0 ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
        <span className={`text-[10px] truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          {activeRecording ? '插入后写入光标处' : '选中录音后可插入'}
        </span>
        <button
          type="button"
          onClick={handleInsert}
          disabled={!activeRecording}
          title="把音频与转写插入笔记"
          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
        >
          <PlusCircle size={12} /> 插入笔记
        </button>
      </div>

      {/* 右下角拖拽手柄：按住拖动可调整面板宽高（尺寸会被记住） */}
      <div
        role="separator"
        aria-label="调整面板大小"
        title="拖拽调整大小"
        onPointerDown={handleResizeStart}
        className={`absolute bottom-0 right-0 z-10 flex h-4 w-4 cursor-nwse-resize items-end justify-end ${
          isDark ? 'text-gray-500 hover:text-gray-300' : 'text-gray-300 hover:text-gray-500'
        }`}
      >
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
          <path d="M14 4 L4 14 M14 10 L10 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </div>
        </div>
      )}

      {/*
       * 常驻录音实例：隐藏全部内置按钮，由工具栏麦克风按钮 / 面板自绘按钮通过 ref 命令式驱动。
       * 录音期间面板整体隐藏，此处常驻挂载保证采集不中断。
       */}
      <AudioRecorder
        ref={recorderRef}
        hideButtons
        onCaptured={handleCaptured}
        onRecordingChange={handleRecordingChange}
        onSupportedChange={setRecorderSupported}
        onError={handleRecorderError}
      />
    </>
  );
  },
);

NoteRecordingPanel.displayName = 'NoteRecordingPanel';

export default NoteRecordingPanel;