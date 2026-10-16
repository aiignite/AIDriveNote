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
import React, { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Mic, Square, AlertTriangle, Upload } from 'lucide-react';
import type { BrowserTranscriptSegment } from '../../../services/note/recording';

/**
 * AudioRecorder 命令式句柄。
 *
 * 供「按钮与录音实例分离」的场景使用：录音实例常驻（不随 UI 布局变化卸载），
 * 由外部自绘按钮通过 start() / stop() 驱动，保证布局切换不会打断正在进行的录音。
 */
export interface AudioRecorderHandle {
  /** 开始录音（申请麦克风） */
  start: () => Promise<void>;
  /** 停止录音并出片 */
  stop: () => void;
  /** 当前是否正在录音 */
  readonly isRecording: boolean;
  /** 当前已录制时长（毫秒） */
  readonly elapsedMs: number;
}

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
  /** 录音状态变化回调（开始 / 停止），供外部自绘按钮同步 UI */
  onRecordingChange?: (recording: boolean) => void;
  /** 录音环境可用性回调，供外部自绘降级入口（隐藏本组件按钮时使用） */
  onSupportedChange?: (supported: boolean) => void;
  /** 隐藏内置按钮（外部自绘 UI，通过 ref 命令式驱动） */
  hideButtons?: boolean;
  /** 录音启动失败回调（如麦克风被拒绝），供外部自绘 UI 提示 */
  onError?: (message: string) => void;
}

/**
 * 浏览器原生录音组件（内嵌 Web Speech API 实时转写）。
 * @param props 组件属性
 * @param ref 命令式句柄（start / stop / isRecording / elapsedMs）
 * @returns 录音 / 停止按钮，或在不可用时的上传降级入口
 */
export const AudioRecorder = forwardRef<AudioRecorderHandle, AudioRecorderProps>(
  ({
    disabled,
    onCaptured,
    maxDurationMs = 60 * 60 * 1000,
    className,
    variant = 'default',
    iconOnly = false,
    onFallbackUpload,
    onRecordingChange,
    onSupportedChange,
    hideButtons,
    onError,
  }, ref) => {
  /** 当前环境是否支持录音 */
  const [supported, setSupported] = useState<boolean>(true);
  /** 不支持录音时隐藏内置按钮（由外部自绘降级入口） */
  const [hideBuiltInButtons, setHideBuiltInButtons] = useState(false);
  /** 是否正在录音 */
  const [recording, setRecording] = useState<boolean>(false);
  /** 已录制时长（毫秒） */
  const [elapsed, setElapsed] = useState<number>(0);
  /** recording / elapsed 的 ref 镜像，供命令式句柄的 getter 读取最新值 */
  const recordingRef = useRef<boolean>(false);
  const elapsedRef = useRef<number>(0);
  recordingRef.current = recording;
  elapsedRef.current = elapsed;
  /** 录音启动中标记（防止异步申请麦克风期间重复触发开始，避免叠加多个 MediaRecorder） */
  const startingRef = useRef<boolean>(false);
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
  /** 识别是否被永久拒绝（not-allowed / service-not-allowed），置真后不再重启 */
  const recognitionDeadRef = useRef<boolean>(false);
  /** 是否正在执行「停止录音」流程（用于区分识别自然结束与主动停止，避免误重启） */
  const stoppingRef = useRef<boolean>(false);
  /** 识别自动重启定时器句柄 */
  const recognitionRestartTimerRef = useRef<number | null>(null);
  /** 开始时间戳 */
  const startedAtRef = useRef<number>(0);
  /** 计时器句柄 */
  const tickRef = useRef<number | null>(null);
  /** 屏幕常亮锁句柄（录音期间阻止手机自动熄屏，避免熄屏后页面被挂起导致录音中断） */
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  /**
   * 申请屏幕常亮锁：录音期间让屏幕保持点亮，避免手机自动熄屏。
   * 不支持 Wake Lock 或申请失败（非安全上下文 / 页面不可见等）时静默忽略。
   * @returns Promise<void>
   */
  const acquireWakeLock = async () => {
    try {
      // 旧版浏览器可能没有 wakeLock（运行时兜底）
      if (typeof navigator === 'undefined' || !navigator.wakeLock) return;
      if (wakeLockRef.current && !wakeLockRef.current.released) return;
      const sentinel = await navigator.wakeLock.request('screen');
      wakeLockRef.current = sentinel;
      // 系统在页面隐藏时会自动释放锁，这里同步句柄，便于回到前台后重新申请
      sentinel.addEventListener('release', () => {
        if (wakeLockRef.current === sentinel) wakeLockRef.current = null;
      });
    } catch { /* 忽略：如非安全上下文 / 用户代理限制 / 页面不可见 */ }
  };

  /**
   * 释放屏幕常亮锁（录音结束 / 组件卸载时调用）。
   * @returns void
   */
  const releaseWakeLock = () => {
    const sentinel = wakeLockRef.current;
    wakeLockRef.current = null;
    if (sentinel && !sentinel.released) {
      void sentinel.release().catch(() => { /* 忽略释放失败 */ });
    }
  };

  useEffect(() => {
    const hasMedia = typeof navigator !== 'undefined'
      && !!navigator.mediaDevices?.getUserMedia
      && typeof window !== 'undefined'
      && window.isSecureContext;
    setSupported(hasMedia);
    onSupportedChange?.(hasMedia);
  }, [onSupportedChange]);

  /** 环境里是否可用 Web Speech API */
  const speechSupported = (): boolean => {
    if (typeof window === 'undefined') return false;
    const w = window as SpeechRecognitionWindow;
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  };

  useEffect(() => () => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current);
    if (recognitionRestartTimerRef.current !== null) {
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
    stoppingRef.current = true;
    try { recognitionRef.current?.stop(); } catch { /* noop */ }
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      try { rec.stop(); } catch { /* noop */ }
    }
    releaseWakeLock();
  }, []);

  // 回到前台且仍在录音时重新申请屏幕常亮锁（页面隐藏时系统会自动释放锁）
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && recordingRef.current) {
        void acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
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
    if (recordingRef.current || startingRef.current) return;
    startingRef.current = true;
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
      // 系统在后台 / 熄屏时可能暂停采集：仍在录音则尝试自动恢复，尽量不中断
      rec.onpause = () => {
        if (recordingRef.current) {
          try { rec.resume(); } catch { /* noop */ }
        }
      };
      rec.start();
      recorderRef.current = rec;
      startedAtRef.current = Date.now();
      setRecording(true);
      setElapsed(0);
      // 录音期间申请屏幕常亮锁，避免手机自动熄屏后页面被挂起导致录音中断
      void acquireWakeLock();

      // 并行启动浏览器内置语音识别（Web Speech API）
      recognitionEndedRef.current = !speechSupported();
      recognitionDeadRef.current = false;
      stoppingRef.current = false;
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
            // 永久性错误（用户 / 系统拒绝授权）：标记后不再重启，后续分段为空
            if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
              recognitionDeadRef.current = true;
              recognitionEndedRef.current = true;
            }
            // no-speech / network / aborted 等瞬时错误不打断录音，交由 onend 自动重启
          };
          srec.onend = () => {
            // 识别在静音 / 超时后会自行结束（continuous 也不保证持续）。
            // 若录音仍在进行且识别未被永久拒绝，则短暂延迟后自动重启，
            // 避免分段只覆盖开头几秒 —— 否则上传时会因「有分段」而跳过服务端
            // 转写，最终只得到半截转写结果（用户反馈的「时间很短 / 无法转译」）。
            if (!stoppingRef.current && recordingRef.current && !recognitionDeadRef.current) {
              if (recognitionRestartTimerRef.current !== null) {
                window.clearTimeout(recognitionRestartTimerRef.current);
              }
              recognitionRestartTimerRef.current = window.setTimeout(() => {
                recognitionRestartTimerRef.current = null;
                if (stoppingRef.current || !recordingRef.current || recognitionDeadRef.current) return;
                try {
                  srec.start();
                } catch {
                  // 重启失败（如实例已失效）：视为识别结束，收尾发射
                  recognitionEndedRef.current = true;
                  if (pendingRef.current) emitCapture();
                }
              }, 300);
              return;
            }
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
      onError?.(msg);
      setRecording(false);
      releaseWakeLock();
    } finally {
      startingRef.current = false;
    }
  };

  /**
   * 停止录音并出片（同时停止浏览器语音识别）。
   * @returns void
   */
  const stopCapture = () => {
    startingRef.current = false;
    // 标记进入停止流程：识别 onend 不再自动重启，改为收尾发射
    stoppingRef.current = true;
    if (recognitionRestartTimerRef.current !== null) {
      window.clearTimeout(recognitionRestartTimerRef.current);
      recognitionRestartTimerRef.current = null;
    }
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
    // 录音结束即释放屏幕常亮锁，恢复正常熄屏
    releaseWakeLock();
  };

  // 录音状态变化时同步给外部（供外部自绘按钮 / 状态点使用）
  useEffect(() => {
    onRecordingChange?.(recording);
  }, [recording, onRecordingChange]);

  // 暴露命令式句柄：start / stop / isRecording / elapsedMs
  useImperativeHandle(ref, () => ({
    start: startCapture,
    stop: stopCapture,
    get isRecording() {
      return recordingRef.current;
    },
    get elapsedMs() {
      return elapsedRef.current;
    },
  }), [startCapture, stopCapture]);

  // 不支持录音：compact 降级为上传入口（绝不返回 null）
  if (!supported) {
    const isHttp = typeof window !== 'undefined' && !window.isSecureContext;
    const hint = isHttp
      ? 'HTTP 环境无法浏览器录音，请上传音频或改用 HTTPS'
      : '当前浏览器不支持录音，请上传音频';

    // 隐藏内置按钮：外部自绘降级入口，本组件仅作为录音实例宿主
    if (hideButtons) return null;

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

  // 隐藏内置按钮：外部自绘 UI，本组件仅作为录音实例宿主
  if (hideButtons) return null;

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
  },
);

AudioRecorder.displayName = 'AudioRecorder';

export default AudioRecorder;
