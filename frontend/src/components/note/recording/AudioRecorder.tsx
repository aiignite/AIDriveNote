/**
 * AudioRecorder.tsx — 浏览器原生录音组件（笔记录音场景，含浏览器内置 ASR）
 *
 * 能力：
 *  - 优先 audio/webm;codecs=opus，浏览器不支持时上报失败；
 *  - 录音时并行启动 Web Speech API（SpeechRecognition / webkitSpeechRecognition）
 *    做实时转写，停止后把近似时间戳的分段随音频 Blob 一并回调；
 *  - 非安全上下文（如 http:// 内网 IP）无法录音，compact 模式降级为上传入口；
 *  - 支持 default / compact 变体与 iconOnly；onFallbackUpload 供降级时打开文件上传。
 *
 * 转写说明：Web Speech API 只能识别实时麦克风输入（无法离线转文件），因此识别
 * 必须在录音期间进行；停止时若识别不可用或无结果，回调里 transcript 为空数组，
 * 由上层决定走服务端转写或跳过。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Mic, Square, AlertTriangle, Upload } from 'lucide-react';
import type { BrowserTranscriptSegment } from '../../../services/note/recording';

// ── Web Speech API 最小类型声明（TS DOM lib 未包含）────────────────────

/** SpeechRecognition 结果条目（只用到 transcript / isFinal） */
interface SpeechRecognitionResultItem {
  transcript: string;
}

/** SpeechRecognition 事件 results 集合的最小结构 */
interface SpeechRecognitionResultListLike {
  /** 结果条目 */
  [index: number]: {
    /** 是否最终结果 */
    isFinal: boolean;
    /** 识别文本（取第一条候选） */
    0: SpeechRecognitionResultItem;
  };
  /** 集合长度 */
  length: number;
}

/** SpeechRecognition 实例最小接口 */
interface SpeechRecognitionLike {
  /** 识别语言，如 zh-CN */
  lang: string;
  /** 是否连续识别（不因停顿自动结束） */
  continuous: boolean;
  /** 是否返回中间结果 */
  interimResults: boolean;
  /** 结果事件 */
  onresult: ((ev: { resultIndex: number; results: SpeechRecognitionResultListLike }) => void) | null;
  /** 错误事件 */
  onerror: ((ev: { error: string }) => void) | null;
  /** 结束事件 */
  onend: (() => void) | null;
  /** 开始识别 */
  start(): void;
  /** 停止识别 */
  stop(): void;
}

/** 挂载到 Window 的构造器（带 webkit 前缀兼容） */
interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
}

/** 识别语言：中文环境用 zh-CN，其余跟随浏览器默认 */
const SPEECH_LANG = typeof navigator !== 'undefined' && /^zh/.test(navigator.language) ? 'zh-CN' : 'en-US';

interface AudioRecorderProps {
  /** 采集成功后禁用，直到调用方重置 */
  disabled?: boolean;
  /** 采集完成回调：音频 Blob、合成文件名、浏览器 ASR 分段（可为空）与时长（毫秒） */
  onCaptured: (
    blob: Blob,
    fileName: string,
    transcript?: BrowserTranscriptSegment[],
    durationMs?: number,
  ) => void;
  /** 最长录音时长（毫秒），默认 60 分钟 */
  maxDurationMs?: number;
  /** 自定义类名 */
  className?: string;
  /** 展示变体：default（默认）/ compact（工具栏） */
  variant?: 'default' | 'compact';
  /** compact 下仅显示图标，文案放入 title */
  iconOnly?: boolean;
  /** 不支持录音时触发，用于打开文件上传入口 */
  onFallbackUpload?: () => void;
}

/**
 * 浏览器原生录音组件（内嵌 Web Speech API 实时转写）。
 * @param props 组件属性
 * @returns 录音 / 停止按钮，或在不可用时的上传降级入口
 */
export const AudioRecorder: React.FC<AudioRecorderProps> = ({
  disabled,
  onCaptured,
  maxDurationMs = 60 * 60 * 1000,
  className,
  variant = 'default',
  iconOnly = false,
  onFallbackUpload,
}) => {
  /** 当前环境是否支持录音 */
  const [supported, setSupported] = useState<boolean>(true);
  /** 是否正在录音 */
  const [recording, setRecording] = useState<boolean>(false);
  /** 已录制时长（毫秒） */
  const [elapsed, setElapsed] = useState<number>(0);
  /** 错误提示 */
  const [error, setError] = useState<string | null>(null);
  /** MediaRecorder 实例 */
  const recorderRef = useRef<MediaRecorder | null>(null);
  /** SpeechRecognition 实例 */
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** 已采集的音频分片 */
  const chunksRef = useRef<Blob[]>([]);
  /** 浏览器 ASR 已确认的分段（近似时间戳） */
  const segmentsRef = useRef<BrowserTranscriptSegment[]>([]);
  /** 上一段的结束时间（秒），用于拼接近似区间 */
  const lastEndRef = useRef<number>(0);
  /** 待发射的采集结果（MediaRecorder 与识别结束事件竞态协调） */
  const pendingRef = useRef<{ blob: Blob; name: string; durationMs: number } | null>(null);
  /** 识别是否已结束（无识别能力时为 true） */
  const recognitionEndedRef = useRef<boolean>(true);
  /** 开始时间戳 */
  const startedAtRef = useRef<number>(0);
  /** 计时器句柄 */
  const tickRef = useRef<number | null>(null);

  useEffect(() => {
    const hasMedia = typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof window !== 'undefined'
      && window.isSecureContext;
    setSupported(hasMedia);
  }, []);

  /** 环境里是否可用 Web Speech API */
  const speechSupported = (): boolean => {
    if (typeof window === 'undefined') return false;
    const w = window as SpeechRecognitionWindow;
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  };

  useEffect(() => () => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* noop */ }
    }
  }, []);

  /**
   * 发射采集结果（onCaptured）——只允许执行一次。
   * @returns void
   */
  const emitCapture = () => {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    const segments = segmentsRef.current.length ? segmentsRef.current : undefined;
    onCaptured(pending.blob, pending.name, segments, pending.durationMs);
    segmentsRef.current = [];
    lastEndRef.current = 0;
  };

  /**
   * 开始录音：申请麦克风，同时启动 MediaRecorder 与浏览器语音识别。
   * @returns Promise<void>
   */
  const startCapture = async () => {
    if (!supported) {
      setError('当前浏览器不支持录音，请改用文件上传。');
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : '';
      const rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };
      rec.onstop = () => {
        const type = rec.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type });
        stream.getTracks().forEach(t => t.stop());
        const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const durationMs = Date.now() - startedAtRef.current;
        pendingRef.current = { blob, name: `recording-${ts}.${ext}`, durationMs };
        chunksRef.current = [];
        // 识别已结束（或无识别能力）时立即发射，否则等识别 onend 补齐分段
        if (recognitionEndedRef.current) emitCapture();
      };
      rec.start();
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
      setElapsed(0);

      // 并行启动浏览器内置语音识别（Web Speech API）
      recognitionEndedRef.current = !speechSupported();
      segmentsRef.current = [];
      lastEndRef.current = 0;
      if (speechSupported()) {
        const w = window as SpeechRecognitionWindow;
        const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
        if (Ctor) {
          const srec = new Ctor();
          srec.lang = SPEECH_LANG;
          srec.continuous = true;
          srec.interimResults = true;
          srec.onresult = (ev) => {
            // 只收集最终结果，用事件时刻的录音进度近似分段时间戳
            const elapsedSec = (Date.now() - startedAtRef.current) / 1000;
            let text = '';
            for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
              if (ev.results[i].isFinal) text += ev.results[i][0].transcript;
            }
            const trimmed = text.trim();
            if (trimmed) {
              const start = lastEndRef.current;
              const end = Math.max(elapsedSec, start + 0.1);
              segmentsRef.current.push({ text: trimmed, start_time: start, end_time: end });
              lastEndRef.current = end;
            }
          };
          srec.onerror = (ev) => {
            // 不打断录音；如识别被拒（not-allowed）则后续分段为空
            if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
              recognitionEndedRef.current = true;
            }
          };
          srec.onend = () => {
            recognitionEndedRef.current = true;
            // 音频已就绪时补齐分段发射
            if (pendingRef.current) emitCapture();
          };
          srec.start();
          recognitionRef.current = srec;
        } else {
          recognitionEndedRef.current = true;
        }
      }

      tickRef.current = window.setInterval(() => {
        const ms = Date.now() - startedAtRef.current;
        setElapsed(ms);
        if (ms >= maxDurationMs) stopCapture();
      }, 250);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : '无法访问麦克风';
      setError(msg);
      setRecording(false);
    }
  };

  /**
   * 停止录音并出片（同时停止浏览器语音识别）。
   * @returns void
   */
  const stopCapture = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* noop */ }
    }
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRecording(false);
  };

  // 不支持录音：compact 降级为上传入口（绝不返回 null）
  if (!supported) {
    const isHttp = typeof window !== 'undefined' && !window.isSecureContext;
    const hint = isHttp
      ? 'HTTP 环境无法浏览器录音，请上传音频或改用 HTTPS'
      : '当前浏览器不支持录音，请上传音频';

    if (variant === 'compact') {
      return (
        <div className={`flex items-center gap-2 ${className || ''}`}>
          <button
            type="button"
            onClick={() => onFallbackUpload?.()}
            disabled={disabled || !onFallbackUpload}
            title={hint}
            aria-label="上传音频"
            className={`inline-flex items-center justify-center font-medium rounded-lg bg-amber-50 text-amber-800 hover:bg-amber-100 border border-amber-200 disabled:opacity-50 shadow-sm ${
              iconOnly ? 'p-2' : 'gap-1.5 px-4 py-2 text-sm'
            }`}
          >
            <Upload size={14} />
            {!iconOnly && '上传音频'}
          </button>
        </div>
      );
    }

    return (
      <div className={`text-xs text-amber-600 flex items-center gap-1 ${className || ''}`}>
        <AlertTriangle size={14} /> {hint}
      </div>
    );
  }

  /**
   * 把毫秒格式化为 mm:ss。
   * @param ms 毫秒数
   * @returns 形如 01:23 的时间文本
   */
  const formatElapsed = (ms: number) => {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const compactIcon = variant === 'compact' && iconOnly;

  return (
    <div className={`flex items-center gap-2 ${className || ''}`}>
      {!recording ? (
        <button
          type="button"
          onClick={startCapture}
          disabled={disabled}
          title="开始录音"
          aria-label="开始录音"
          className={`inline-flex items-center justify-center font-medium disabled:opacity-50 ${
            compactIcon
              ? 'p-2 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 shadow-sm'
              : 'gap-1.5 px-3 py-1.5 text-xs rounded-md bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200'
          }`}
        >
          <Mic size={14} />
          {!compactIcon && '开始录音'}
        </button>
      ) : (
        <button
          type="button"
          onClick={stopCapture}
          title={`停止录音 (${formatElapsed(elapsed)})`}
          aria-label={`停止录音 (${formatElapsed(elapsed)})`}
          className={`inline-flex items-center justify-center font-medium ${
            compactIcon
              ? 'p-2 rounded-lg bg-rose-600 text-white hover:bg-rose-700 shadow-sm'
              : 'gap-1.5 px-3 py-1.5 text-xs rounded-md bg-rose-600 text-white hover:bg-rose-700'
          }`}
        >
          <Square size={14} />
          {!compactIcon && `停止 (${formatElapsed(elapsed)})`}
        </button>
      )}
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </div>
  );
};

export default AudioRecorder;
