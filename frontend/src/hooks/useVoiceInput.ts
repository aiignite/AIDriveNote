/**
 * useVoiceInput — AI 助手统一语音输入 Hook（实时识别 + 录音转写回退）
 *
 * 设计目标：让移动端也能用上语音输入。
 *
 *  1. 首选通道：复用 `useSpeechInput`（Web Speech API）做实时识别，体验最好。
 *     但它在移动端普遍受限：iOS Safari / 微信内置浏览器常缺少该 API，安卓部分
 *     机型会直接抛 `service-not-allowed`。
 *  2. 回退通道：`getUserMedia` + `MediaRecorder` 录音，上传到后端
 *     `/note-recordings` 走服务端 Whisper 转写（与富文本编辑器的录音链路一致）。
 *     该通道只需要麦克风权限，在移动端可用性远高于 Web Speech API。
 *  3. 运行期兜底：实时识别抛出致命错误时，自动切换到录音通道并提示用户。
 *
 * 后端零改动：完全复用既有笔记录音 / 转写接口。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSpeechInput, FATAL_SPEECH_ERRORS } from './useSpeechInput';
import { noteRecordingApi } from '../services/note/recording';

/** 转写结果轮询间隔（毫秒） */
const TRANSCRIBE_POLL_INTERVAL_MS = 2000;

/** 转写等待超时（毫秒），超时视为失败 */
const TRANSCRIBE_TIMEOUT_MS = 60_000;

/** 提示文案的自动消失时长（毫秒） */
const HINT_DURATION_MS = 6000;

/** 语音输入通道 */
export type VoiceInputMode = 'realtime' | 'recording';

/**
 * 选择当前浏览器支持的最佳录音 MIME 类型。
 * @returns MIME 类型字符串；都不支持时返回空串（交给浏览器默认）
 */
function pickMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/**
 * 按 MIME 类型推导文件扩展名（与 AudioRecorder、后端白名单保持一致）。
 * @param type 录音 MIME 类型
 * @returns 文件扩展名
 */
function extFromMime(type: string): string {
  if (type.includes('mp4')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

/**
 * 简易延时。
 * @param ms 毫秒
 * @returns Promise<void>
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

export interface UseVoiceInputOptions {
  /** 每识别出一段文本（实时识别的最终结果，或录音转写的整段结果）时回调 */
  onFinal?: (text: string) => void;
  /** 强制使用录音转写通道（跳过硬实时识别） */
  forceRecording?: boolean;
}

export interface UseVoiceInputReturn {
  /** 当前环境是否可用语音输入（任一通道可用即为 true） */
  supported: boolean;
  /** 当前采用的通道 */
  mode: VoiceInputMode;
  /** 是否正在采集语音（实时聆听或录音中） */
  listening: boolean;
  /** 是否正在做服务端转写（录音通道） */
  transcribing: boolean;
  /** 实时识别的中间态文本（仅实时通道有值） */
  interimText: string;
  /** 错误提示（无错误为 null） */
  error: string | null;
  /** 通道切换 / 环境提示文案（如“已切换为录音识别”） */
  hint: string | null;
  /** 开始或停止语音输入 */
  toggle: () => void;
  /** 停止语音输入 */
  stop: () => void;
  /** 清空错误状态 */
  reset: () => void;
}

/**
 * AI 助手统一语音输入 Hook。
 *
 * @param options 回调与通道配置
 * @returns 统一的语音输入状态与操作函数
 */
export function useVoiceInput(options: UseVoiceInputOptions = {}): UseVoiceInputReturn {
  const { onFinal, forceRecording: forceRecordingProp = false } = options;

  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  /** 组件的挂载标记，避免卸载后仍更新状态或上传 */
  const mountedRef = useRef(true);

  /** 是否因运行期致命错误而强制走录音通道 */
  const [forceRecording, setForceRecording] = useState<boolean>(forceRecordingProp);
  /** 是否正在录音（录音通道） */
  const [recording, setRecording] = useState<boolean>(false);
  /** 是否正在服务端转写 */
  const [transcribing, setTranscribing] = useState<boolean>(false);
  /** 录音通道的错误提示 */
  const [recordingError, setRecordingError] = useState<string | null>(null);
  /** 通道切换 / 环境提示 */
  const [hint, setHint] = useState<string | null>(null);

  /** 录音分片缓冲 */
  const chunksRef = useRef<Blob[]>([]);
  /** MediaRecorder 实例 */
  const recorderRef = useRef<MediaRecorder | null>(null);
  /** 麦克风媒体流 */
  const streamRef = useRef<MediaStream | null>(null);
  /** 录音开始时间戳 */
  const startedAtRef = useRef<number>(0);

  // 实时识别通道（首选）
  const {
    supported: speechSupported,
    listening: speechListening,
    interimText: speechInterimText,
    error: speechError,
    errorCode: speechErrorCode,
    stop: speechStop,
    toggle: speechToggle,
    reset: speechReset,
  } = useSpeechInput({ onFinal: text => onFinalRef.current?.(text) });

  // 外部强制参数变化时同步内部状态
  useEffect(() => {
    if (forceRecordingProp) setForceRecording(true);
  }, [forceRecordingProp]);

  /** 当前环境是否支持录音采集（需要安全上下文 + getUserMedia + MediaRecorder） */
  const recorderSupported = typeof window !== 'undefined'
    && window.isSecureContext !== false
    && !!navigator.mediaDevices?.getUserMedia
    && typeof MediaRecorder !== 'undefined';

  /** 是否使用录音转写通道 */
  const useRecording = forceRecording || !speechSupported;

  /** 综合可用性：实时通道可用，或录音通道可用 */
  const supported = useRecording ? recorderSupported : speechSupported;

  /** 当前通道 */
  const mode: VoiceInputMode = useRecording ? 'recording' : 'realtime';

  /**
   * 上传录音并轮询转写结果，成功后把整段文本回传。
   * @param file 录音文件
   * @param durationSec 录音时长（秒）
   * @returns Promise<void>
   */
  const runTranscription = useCallback(async (file: File, durationSec: number): Promise<void> => {
    if (!mountedRef.current) return;
    setTranscribing(true);
    setRecordingError(null);
    let recordingId: string | null = null;
    try {
      const created = await noteRecordingApi.uploadRecording(file, undefined, undefined, durationSec);
      recordingId = created.id;
      const deadline = Date.now() + TRANSCRIBE_TIMEOUT_MS;
      let text = '';
      // 轮询直到转写完成 / 失败 / 超时
      while (Date.now() < deadline) {
        const result = await noteRecordingApi.getTranscript(recordingId);
        if (!mountedRef.current) return;
        if (result.status === 'Transcribed') {
          text = result.segments.map(seg => seg.text.trim()).filter(Boolean).join('');
          break;
        }
        if (result.status === 'Failed') {
          throw new Error(result.errorMessage || '语音转写失败，请重试');
        }
        await sleep(TRANSCRIBE_POLL_INTERVAL_MS);
      }
      if (!mountedRef.current) return;
      if (!text) throw new Error('未识别到语音内容，请重试');
      onFinalRef.current?.(text);
    } catch (e: unknown) {
      if (mountedRef.current) {
        setRecordingError(e instanceof Error ? e.message : '语音识别失败，请重试');
      }
    } finally {
      if (mountedRef.current) setTranscribing(false);
      // 临时录音用完即删，避免污染用户的录音列表
      if (recordingId) {
        void noteRecordingApi.deleteRecording(recordingId).catch(() => { /* 清理失败不影响主流程 */ });
      }
    }
  }, []);

  /**
   * 停止录音并触发上传转写。
   * @returns void
   */
  const stopRecording = useCallback((): void => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        /* 已停止时忽略 */
      }
    }
  }, []);

  /**
   * 开始录音（申请麦克风 → MediaRecorder 采集）。
   * @returns Promise<void>
   */
  const startRecording = useCallback(async (): Promise<void> => {
    if (!recorderSupported) {
      setRecordingError('当前浏览器不支持录音，请检查是否在安全上下文（https）下访问');
      return;
    }
    setRecordingError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = pickMimeType();
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = ev => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        chunksRef.current = [];
        streamRef.current?.getTracks().forEach(track => track.stop());
        streamRef.current = null;
        recorderRef.current = null;
        const durationSec = Math.max(0, Math.round((Date.now() - startedAtRef.current) / 1000));
        if (!mountedRef.current) return;
        setRecording(false);
        // 用真实 File（带正确扩展名）上传：后端按扩展名做白名单校验
        const file = new File([blob], `voice-${Date.now()}.${extFromMime(type)}`, { type });
        void runTranscription(file, durationSec);
      };
      rec.start();
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
    } catch (e: unknown) {
      if (!mountedRef.current) return;
      const denied = e instanceof Error && (e.name === 'NotAllowedError' || e.name === 'SecurityError');
      setRecordingError(denied ? '麦克风权限被拒绝，请在浏览器设置中允许' : '无法访问麦克风，请检查设备权限');
      setRecording(false);
    }
  }, [recorderSupported, runTranscription]);

  // 运行期兜底：实时识别出现致命错误时，自动切换到录音通道
  useEffect(() => {
    if (forceRecording) return;
    if (speechErrorCode && FATAL_SPEECH_ERRORS.has(speechErrorCode)) {
      setForceRecording(true);
      setHint('当前浏览器限制了在线语音识别，已自动切换为录音识别');
      speechReset();
    }
  }, [speechErrorCode, forceRecording, speechReset]);

  // 环境提示：浏览器根本不支持实时识别时，直接说明已使用录音识别
  useEffect(() => {
    if (!speechSupported && recorderSupported) {
      setHint('当前浏览器不支持在线语音识别，已使用录音识别');
    }
  }, [speechSupported, recorderSupported]);

  // 提示文案短暂展示后自动消失，避免长期占用输入区空间
  useEffect(() => {
    if (!hint) return;
    const timer = window.setTimeout(() => setHint(null), HINT_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [hint]);

  /**
   * 开始或停止语音输入。
   * @returns void
   */
  const toggle = useCallback((): void => {
    if (transcribing) return; // 转写中忽略重复操作
    if (useRecording) {
      if (recording) stopRecording();
      else void startRecording();
    } else {
      speechToggle();
    }
  }, [transcribing, useRecording, recording, stopRecording, startRecording, speechToggle]);

  /**
   * 停止语音输入。
   * @returns void
   */
  const stop = useCallback((): void => {
    if (useRecording) stopRecording();
    else speechStop();
  }, [useRecording, stopRecording, speechStop]);

  /**
   * 清空错误状态（不改变通道选择）。
   * @returns void
   */
  const reset = useCallback((): void => {
    setRecordingError(null);
    speechReset();
  }, [speechReset]);

  // 卸载时停止录音、释放麦克风，避免设备指示灯常亮
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const rec = recorderRef.current;
      if (rec && rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* 忽略 */
        }
      }
      recorderRef.current = null;
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    };
  }, []);

  /** 综合聆听状态：录音通道看录音态，实时通道看识别态 */
  const listening = useRecording ? recording : speechListening;

  return {
    supported,
    mode,
    listening,
    transcribing,
    interimText: useRecording ? '' : speechInterimText,
    error: useRecording ? recordingError : speechError,
    hint,
    toggle,
    stop,
    reset,
  };
}

export default useVoiceInput;