/**
 * useNoteRecording — 笔记录音 / 转写 / 大模型整理的状态管理 Hook
 *
 * 由会议版 useMeetingRecording 去会议化移植：接口换成 /note-recordings 契约，
 * 保留以下核心能力：
 *  - 按 status 每 2s 轮询（Uploaded → Transcribing → Transcribed / Failed）；
 *  - 转写完成后自动拉取分段；
 *  - 上传、重转写、AI 整理（refine）、删除；
 *  - 切换笔记时重置全部状态并清理轮询。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  noteRecordingApi,
  type BrowserTranscriptSegment,
  type NoteRecording,
  type TranscriptSegment,
} from '../services/note/recording';

/** 轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 2000;

/** Hook 可选项 */
interface UseNoteRecordingOptions {
  /** 为 false 时不在 noteId 变化时自动拉取录音（延迟到面板打开时再加载）。 */
  enabled?: boolean;
}

/** Hook 返回值 */
interface UseNoteRecordingResult {
  /** 当前笔记的录音列表 */
  recordings: NoteRecording[];
  /** 当前选中的录音 */
  activeRecording: NoteRecording | null;
  /** 当前录音的转写分段 */
  transcriptSegments: TranscriptSegment[];
  /** 列表加载中 */
  isRecordingsLoading: boolean;
  /** 转写加载中 */
  isTranscriptLoading: boolean;
  /** 上传中 */
  isUploading: boolean;
  /** 正在重转写的录音 id */
  retranscribingId: string | null;
  /** 正在整理的录音 id */
  refiningId: string | null;
  /** 错误提示 */
  error: string | null;
  /** 加载指定笔记的录音列表 */
  loadRecordings: (nid: string) => Promise<void>;
  /** 选中某条录音（若已转写则拉取分段） */
  selectRecording: (rec: NoteRecording) => Promise<void>;
  /** 上传音频 */
  uploadRecording: (
    file: File | Blob,
    fileName?: string,
    transcript?: BrowserTranscriptSegment[],
    durationMs?: number,
  ) => Promise<void>;
  /** 重新转写 */
  retranscribe: (rec: NoteRecording) => Promise<void>;
  /** AI 整理 / 润色 */
  refine: (rec: NoteRecording) => Promise<void>;
  /** 删除录音 */
  remove: (rec: NoteRecording) => Promise<void>;
  /** 直接设置当前录音 */
  setActiveRecording: (rec: NoteRecording | null) => void;
  /** 清空全部状态 */
  reset: () => void;
}

/**
 * 从任意错误对象中提取可读的错误文案。
 * @param err 捕获到的异常
 * @param fallback 兜底文案
 * @returns 可读错误信息
 */
function extractErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error) return err.message || fallback;
  if (typeof err === 'string') return err;
  return fallback;
}

/**
 * 笔记录音 / 转写状态管理 Hook。
 * @param noteId 当前笔记 id（为 null 时不加载）
 * @param options 可选项
 * @returns 录音状态与操作方法
 */
export function useNoteRecording(
  noteId: string | null,
  options: UseNoteRecordingOptions = {},
): UseNoteRecordingResult {
  const [recordings, setRecordings] = useState<NoteRecording[]>([]);
  const [activeRecording, setActiveRecording] = useState<NoteRecording | null>(null);
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([]);
  const [isRecordingsLoading, setIsRecordingsLoading] = useState(false);
  const [isTranscriptLoading, setIsTranscriptLoading] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [retranscribingId, setRetranscribingId] = useState<string | null>(null);
  const [refiningId, setRefiningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 轮询定时器 */
  const pollTimerRef = useRef<number | null>(null);
  /** 轮询请求取消控制器 */
  const abortRef = useRef<AbortController | null>(null);
  /** 最新 active 录音 id（供轮询闭包读取） */
  const activeIdRef = useRef<string | null>(null);
  /** 最新 noteId（供轮询闭包读取） */
  const noteIdRef = useRef<string | null>(noteId);
  activeIdRef.current = activeRecording?.id ?? null;
  noteIdRef.current = noteId;

  /** 停止轮询并取消进行中的请求 */
  const stopPolling = useCallback(() => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * 拉取一次指定录音的转写分段。
   * @param recId 录音 id
   * @returns Promise<void>
   */
  const fetchTranscriptOnce = useCallback(async (recId: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      setIsTranscriptLoading(true);
      const result = await noteRecordingApi.getTranscript(recId);
      if (!controller.signal.aborted) {
        setTranscriptSegments(result.segments || []);
      }
    } catch {
      /* 转写可能尚未就绪，忽略本次错误，交给下一轮 */
    } finally {
      if (!controller.signal.aborted) setIsTranscriptLoading(false);
    }
  }, []);

  /**
   * 加载指定笔记的录音列表。
   * @param nid 笔记 id
   * @returns Promise<void>
   */
  const loadRecordings = useCallback(async (nid: string) => {
    setIsRecordingsLoading(true);
    setError(null);
    try {
      const res = await noteRecordingApi.listRecordings(nid);
      const list = Array.isArray(res?.items) ? res.items : [];
      setRecordings(list);
      setActiveRecording(prev => {
        if (prev && list.some(r => r.id === prev.id)) return prev;
        return list[0] ?? null;
      });
    } catch (e) {
      setError(extractErrorMessage(e, '加载录音失败'));
    } finally {
      setIsRecordingsLoading(false);
    }
  }, []);

  /**
   * 选中一条录音；若已转写则立即拉取分段。
   * @param rec 录音记录
   * @returns Promise<void>
   */
  const selectRecording = useCallback(async (rec: NoteRecording) => {
    setActiveRecording(rec);
    setTranscriptSegments([]);
    if (rec.status === 'Transcribed') {
      await fetchTranscriptOnce(rec.id);
    }
  }, [fetchTranscriptOnce]);

  /**
   * 上传音频。
   *
   * 若附带 ``transcript``（浏览器内置 ASR 分段），上传接口会一并提交给后端
   * 直接落库（状态立即为 Transcribed），否则走服务端 Whisper 流水线。
   *
   * @param file Blob 或 File
   * @param fileName Blob 时的合成文件名
   * @param transcript 浏览器 ASR 分段（可空）
   * @param durationMs 录音时长（毫秒，浏览器上报）
   * @returns Promise<void>
   */
  const uploadRecording = useCallback(async (
    file: File | Blob,
    fileName?: string,
    transcript?: BrowserTranscriptSegment[],
    durationMs?: number,
  ) => {
    const nid = noteIdRef.current;
    const realFile = file instanceof File
      ? file
      : new File([file], fileName || 'recording.webm', { type: (file as Blob).type || 'audio/webm' });
    setIsUploading(true);
    setError(null);
    try {
      const hasTranscript = !!transcript && transcript.length > 0;
      const durationSeconds = durationMs && durationMs > 0 ? durationMs / 1000 : undefined;
      const rec = await noteRecordingApi.uploadRecording(
        realFile,
        nid ?? undefined,
        hasTranscript ? transcript : undefined,
        hasTranscript ? durationSeconds : undefined,
      );
      setRecordings(prev => [rec, ...prev]);
      setActiveRecording(rec);
      setTranscriptSegments([]);
      // 浏览器 ASR 直接落库后即为 Transcribed，立即拉取分段
      if (rec.status === 'Transcribed') {
        await fetchTranscriptOnce(rec.id);
      }
    } catch (e) {
      setError(extractErrorMessage(e, '上传失败'));
    } finally {
      setIsUploading(false);
    }
  }, [fetchTranscriptOnce]);

  /**
   * 重新触发转写。
   * @param rec 录音记录
   * @returns Promise<void>
   */
  const retranscribe = useCallback(async (rec: NoteRecording) => {
    setError(null);
    setRetranscribingId(rec.id);
    try {
      const refreshed = await noteRecordingApi.retranscribe(rec.id);
      setRecordings(prev => prev.map(r => (r.id === refreshed.id ? refreshed : r)));
      setActiveRecording(refreshed);
      setTranscriptSegments([]);
    } catch (e) {
      setError(extractErrorMessage(e, '重新转写失败'));
    } finally {
      setRetranscribingId(prev => (prev === rec.id ? null : prev));
    }
  }, []);

  /**
   * 调用大模型整理 / 润色转写文本。
   * @param rec 录音记录
   * @returns Promise<void>
   */
  const refine = useCallback(async (rec: NoteRecording) => {
    setError(null);
    setRefiningId(rec.id);
    try {
      const refreshed = await noteRecordingApi.refine(rec.id);
      setRecordings(prev => prev.map(r => (r.id === refreshed.id ? refreshed : r)));
      setActiveRecording(refreshed);
      if (refreshed.status === 'Transcribed') {
        await fetchTranscriptOnce(rec.id);
      }
    } catch (e) {
      setError(extractErrorMessage(e, 'AI 整理失败'));
    } finally {
      setRefiningId(prev => (prev === rec.id ? null : prev));
    }
  }, [fetchTranscriptOnce]);

  /**
   * 删除一条录音。
   * @param rec 录音记录
   * @returns Promise<void>
   */
  const remove = useCallback(async (rec: NoteRecording) => {
    try {
      await noteRecordingApi.deleteRecording(rec.id);
      setRecordings(prev => prev.filter(r => r.id !== rec.id));
      setActiveRecording(prev => (prev?.id === rec.id ? null : prev));
      setTranscriptSegments(prev => (activeIdRef.current === rec.id ? [] : prev));
    } catch (e) {
      setError(extractErrorMessage(e, '删除失败'));
    }
  }, []);

  /** 清空全部状态并停止轮询 */
  const reset = useCallback(() => {
    stopPolling();
    setRecordings([]);
    setActiveRecording(null);
    setTranscriptSegments([]);
    setError(null);
  }, [stopPolling]);

  const enabled = options.enabled !== false;

  // 切换笔记时清理轮询
  useEffect(() => () => stopPolling(), [stopPolling, noteId]);

  // noteId / enabled 变化时加载列表
  useEffect(() => {
    if (!enabled) {
      stopPolling();
      return;
    }
    if (noteId) {
      void loadRecordings(noteId);
    } else {
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteId, enabled]);

  // 按状态启动 / 停止轮询
  useEffect(() => {
    stopPolling();
    if (!enabled || !activeRecording) return;
    const status = activeRecording.status;
    if (status === 'Uploaded' || status === 'Transcribing') {
      pollTimerRef.current = window.setInterval(() => {
        const rid = activeIdRef.current;
        if (!rid) return;
        const controller = new AbortController();
        abortRef.current = controller;
        noteRecordingApi
          .getRecording(rid)
          .then(detail => {
            if (controller.signal.aborted) return;
            setRecordings(prev => prev.map(r => (r.id === detail.id ? detail : r)));
            setActiveRecording(prev => (prev?.id === detail.id ? detail : prev));
            if (detail.status === 'Transcribed' || detail.status === 'Failed') {
              stopPolling();
              if (detail.status === 'Transcribed') void fetchTranscriptOnce(rid);
            }
          })
          .catch(() => { /* 下一轮重试 */ });
      }, POLL_INTERVAL_MS);
    } else if (status === 'Transcribed') {
      void fetchTranscriptOnce(activeRecording.id);
    }
    return () => stopPolling();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, activeRecording?.id, activeRecording?.status, fetchTranscriptOnce, stopPolling]);

  return {
    recordings,
    activeRecording,
    transcriptSegments,
    isRecordingsLoading,
    isTranscriptLoading,
    isUploading,
    retranscribingId,
    refiningId,
    error,
    loadRecordings,
    selectRecording,
    uploadRecording,
    retranscribe,
    refine,
    remove,
    setActiveRecording,
    reset,
  };
}

export default useNoteRecording;