/**
 * NoteRecordingPanel.tsx — 富文本笔记录音 / 转写 / AI 整理主面板
 *
 * 由会议版录音能力去会议化整合：提供录音、上传、状态展示、转写预览，
 * 并通过「插入笔记」把音频块与转写文本块交给父组件（云笔记富文本编辑器）
 * 插入到当前光标处。
 */
import React, { useMemo, useRef, useState } from 'react';
import type { PartialBlock } from '@blocknote/core';
import { Mic, Upload, Trash2, X, FileAudio, Loader2, PlusCircle } from 'lucide-react';
import toast from 'react-hot-toast';
import { useNoteRecording } from '../../../hooks/useNoteRecording';
import { noteRecordingApi, resolveAudioUrl, type BrowserTranscriptSegment } from '../../../services/note/recording';
import { transcriptToBlocks, buildAudioBlock } from '../../../utils/noteAudioBlocks';
import { AudioRecorder } from './AudioRecorder';
import { AudioUploader } from './AudioUploader';
import { RecordingStatusBadge } from './RecordingStatusBadge';
import { TranscriptPreview } from './TranscriptPreview';

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
}

/**
 * 录音主面板组件。
 * @param props 组件属性
 * @returns 录音面板抽屉
 */
export const NoteRecordingPanel: React.FC<NoteRecordingPanelProps> = ({
  open,
  noteId,
  isDark = false,
  onClose,
  onInsert,
}) => {
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
  /** 命令式打开文件选择（供录音降级使用） */
  const uploadOpenRef = useRef<(() => void) | null>(null);

  /** 当前录音是否正在执行某动作 */
  const busyAction = useMemo<'retranscribe' | 'refine' | null>(() => {
    if (!activeRecording) return null;
    if (retranscribingId === activeRecording.id) return 'retranscribe';
    if (refiningId === activeRecording.id) return 'refine';
    return null;
  }, [activeRecording, retranscribingId, refiningId]);

  if (!open) return null;

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

  const cardCls = `rounded-lg border ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'}`;

  return (
    <div className="fixed inset-0 z-[70] flex justify-end bg-black/30" onClick={onClose}>
      <div
        className={`w-full max-w-md h-full flex flex-col shadow-2xl ${isDark ? 'bg-gray-900 text-gray-100' : 'bg-white text-gray-900'}`}
        onClick={e => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
          <div className="flex items-center gap-2">
            <Mic size={16} className="text-rose-500" />
            <h3 className="text-sm font-semibold">录音转写</h3>
          </div>
          <button type="button" onClick={onClose} className={isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-800'}>
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
          {/* 采集操作区 */}
          <div className={`p-3 space-y-3 ${cardCls}`}>
            <div className="flex items-center gap-2 flex-wrap">
              <AudioRecorder
                variant="compact"
                disabled={isUploading}
                onCaptured={handleCaptured}
                onFallbackUpload={() => uploadOpenRef.current?.()}
              />
              <AudioUploader
                variant="compact"
                disabled={isUploading}
                onSelected={handleSelected}
                openRef={uploadOpenRef}
              />
              <button
                type="button"
                onClick={() => setShowDropzone(v => !v)}
                className={`inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border ${
                  isDark ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                }`}
                title="展开拖拽上传区"
              >
                <Upload size={12} /> 拖拽上传
              </button>
            </div>
            {showDropzone && (
              <AudioUploader disabled={isUploading} onSelected={handleSelected} />
            )}
            {isUploading && (
              <p className="text-xs text-sky-600 flex items-center gap-1">
                <Loader2 size={12} className="animate-spin" /> 上传中…
              </p>
            )}
          </div>

          {/* 错误提示 */}
          {error && <p className="text-xs text-rose-600 break-all">{error}</p>}

          {/* 录音列表 */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <p className={`text-xs font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                录音列表（{recordings.length}）
              </p>
              {isRecordingsLoading && <Loader2 size={12} className="animate-spin text-gray-400" />}
            </div>
            {recordings.length === 0 && !isRecordingsLoading && (
              <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>暂无录音，点击上方开始录制或上传</p>
            )}
            {recordings.map(rec => (
              <button
                key={rec.id}
                type="button"
                onClick={() => void selectRecording(rec)}
                className={`w-full text-left p-2 rounded-lg border transition-colors ${
                  activeRecording?.id === rec.id
                    ? (isDark ? 'border-sky-500 bg-sky-900/20' : 'border-sky-400 bg-sky-50')
                    : (isDark ? 'border-gray-700 hover:bg-gray-800' : 'border-gray-100 hover:bg-gray-50')
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-xs truncate">
                    <FileAudio size={12} className="shrink-0 text-gray-400" />
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
                    <Trash2 size={12} />
                  </span>
                </div>
                <div className="mt-1">
                  <RecordingStatusBadge status={rec.status} progressPct={rec.progressPct} errorMessage={rec.errorMessage} />
                </div>
              </button>
            ))}
          </div>

          {/* 转写预览 */}
          {activeRecording && (
            <div className={`p-3 space-y-2 ${cardCls}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold truncate">{activeRecording.fileName}</span>
                <RecordingStatusBadge status={activeRecording.status} progressPct={activeRecording.progressPct} />
              </div>
              {/* 音频试听（audioUrl 缺失时用 buildAudioUrl 兜底） */}
              <audio
                controls
                preload="metadata"
                src={resolveAudioUrl(activeRecording.audioUrl, activeRecording.id)}
                className="w-full h-9"
              />
              {isTranscriptLoading ? (
                <p className="text-xs text-gray-400 flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" /> 加载转写…
                </p>
              ) : activeRecording.status === 'Transcribed' ? (
                <TranscriptPreview
                  segments={transcriptSegments}
                  isDark={isDark}
                  busyAction={busyAction}
                  onAiOrganize={() => void refine(activeRecording)}
                  onRepolish={() => void refine(activeRecording)}
                  onRetranscribe={() => void retranscribe(activeRecording)}
                />
              ) : (
                <p className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {activeRecording.status === 'Failed' ? '转写失败' : '转写处理中…'}
                </p>
              )}
            </div>
          )}
        </div>

        {/* 底部：插入笔记 */}
        <div className={`px-4 py-3 border-t flex justify-end gap-2 ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
          <button
            type="button"
            onClick={onClose}
            className={`px-3 py-1.5 text-xs rounded-lg border ${isDark ? 'border-gray-600 text-gray-300' : 'border-gray-300 text-gray-600'}`}
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleInsert}
            disabled={!activeRecording}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <PlusCircle size={13} /> 插入笔记
          </button>
        </div>
      </div>
    </div>
  );
};

export default NoteRecordingPanel;