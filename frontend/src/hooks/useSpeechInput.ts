/**
 * useSpeechInput — 浏览器原生语音输入 Hook（Web Speech API）
 *
 * 封装 SpeechRecognition / webkitSpeechRecognition，用于把麦克风语音实时转成文字。
 * 与既有笔记录音（AudioRecorder）链路相互独立：本 Hook 只做“语音转文字”，
 * 不涉及音频采集、上传与后端转写，因此零后端改动。
 *
 * 注意：Web Speech API 仅在安全上下文（https / localhost）可用；不支持时
 * supported 为 false，调用方应禁用入口并给出提示。
 *
 * 稳定性设计（避免长时间聆听把标签页拖崩）：
 * - 自动重启有上限与最小间隔，杜绝「报错 → onend → 立刻 start」的高频紧循环；
 * - 空闲超过阈值自动停止，避免“说完不管”导致识别在后台常驻；
 * - 致命错误（权限/无声卡等）立即停止，不做无意义重启；
 * - 中间结果按固定间隔节流刷新，避免宿主组件（如 BlockNote 编辑器）高频重渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

// ── Web Speech API 最小类型声明（TS DOM lib 未包含）────────────────────

/** 识别结果条目（只用到 transcript） */
interface SpeechRecognitionResultItemLike {
  /** 识别文本 */
  transcript: string;
}

/** 识别结果集合的最小结构 */
interface SpeechRecognitionResultListLike {
  /** 结果条目 */
  [index: number]: {
    /** 是否最终结果 */
    isFinal: boolean;
    /** 识别文本（取第一条候选） */
    0: SpeechRecognitionResultItemLike;
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

/** 语音识别错误码 → 中文提示 */
const ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': '麦克风权限被拒绝，请在浏览器设置中允许',
  'service-not-allowed': '当前环境不允许语音识别',
  'no-speech': '未检测到语音，请重试',
  'audio-capture': '未找到可用麦克风',
  network: '语音识别服务网络异常',
};

/** 静音/主动中止类错误：属于连续识别下的正常事件，不提示、可继续重启 */
const BENIGN_ERRORS = new Set(['no-speech', 'aborted']);

/** 致命错误：环境层面不可用，继续重启只会造成循环，必须立即停止 */
const FATAL_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);

/** 单次聆听允许的最大自动重启次数（超出即停止，防止无限循环） */
const MAX_RESTARTS = 3;

/** 两次自动重启之间的最小间隔（毫秒），杜绝高频紧循环打满主线程 */
const MIN_RESTART_DELAY_MS = 300;

/** 连续无识别结果的最长空闲时长（毫秒），超过则自动停止聆听 */
const IDLE_TIMEOUT_MS = 30_000;

/** 中间结果刷新间隔（毫秒），用于节流宿主组件重渲染 */
const INTERIM_THROTTLE_MS = 150;

export interface UseSpeechInputOptions {
  /** 每识别出一段最终文本时回调 */
  onFinal?: (text: string) => void;
  /** 识别语言（默认跟随浏览器，中文环境为 zh-CN） */
  lang?: string;
}

export interface UseSpeechInputReturn {
  /** 当前环境是否支持语音输入 */
  supported: boolean;
  /** 是否正在聆听 */
  listening: boolean;
  /** 中间态识别文本（未确认） */
  interimText: string;
  /** 错误提示（无错误为 null） */
  error: string | null;
  /** 开始聆听 */
  start: () => void;
  /** 停止聆听 */
  stop: () => void;
  /** 切换聆听状态 */
  toggle: () => void;
  /** 清空中间态与错误 */
  reset: () => void;
}

/** 默认识别语言：中文环境用 zh-CN，其余跟随浏览器 */
const DEFAULT_LANG = typeof navigator !== 'undefined' && /^zh/i.test(navigator.language)
  ? 'zh-CN'
  : (typeof navigator !== 'undefined' ? navigator.language : 'en-US');

/**
 * 浏览器原生语音输入 Hook。
 *
 * @param options 回调与语言配置
 * @returns 监听状态与操作函数
 */
export function useSpeechInput(options: UseSpeechInputOptions = {}): UseSpeechInputReturn {
  const { onFinal, lang = DEFAULT_LANG } = options;

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const listeningRef = useRef(false);
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  /** 是否仍允许自动重启（致命错误或主动停止后置为 false） */
  const canRestartRef = useRef(true);
  /** 本轮聆听已发生的自动重启次数 */
  const restartCountRef = useRef(0);
  /** 最近一次拿到识别结果的时间戳（用于空闲判定） */
  const lastResultAtRef = useRef(0);
  /** 自动重启定时器句柄 */
  const restartTimerRef = useRef<number | null>(null);
  /** 中间结果节流定时器句柄 */
  const interimTimerRef = useRef<number | null>(null);
  /** 待刷新的中间结果缓冲（节流用） */
  const pendingInterimRef = useRef('');
  /** stop 的稳定引用：供 onend / 定时器回调内部调用，避免闭包依赖顺序问题 */
  const stopRef = useRef<() => void>(() => {});

  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const supported = typeof window !== 'undefined'
    && Boolean(
      (window as SpeechRecognitionWindow).SpeechRecognition
      || (window as SpeechRecognitionWindow).webkitSpeechRecognition,
    )
    && (typeof window === 'undefined' || window.isSecureContext !== false);

  /**
   * 清理自动重启定时器
   * @returns 无
   */
  const clearRestartTimer = useCallback(() => {
    if (restartTimerRef.current !== null) {
      window.clearTimeout(restartTimerRef.current);
      restartTimerRef.current = null;
    }
  }, []);

  /**
   * 清理中间结果节流定时器与缓冲
   * @returns 无
   */
  const clearInterimTimer = useCallback(() => {
    if (interimTimerRef.current !== null) {
      window.clearTimeout(interimTimerRef.current);
      interimTimerRef.current = null;
    }
    pendingInterimRef.current = '';
  }, []);

  /**
   * 按固定间隔节流刷新中间结果，降低宿主组件重渲染频率
   * @param interim 本次识别出的中间态文本
   * @returns 无
   */
  const pushInterim = useCallback((interim: string) => {
    pendingInterimRef.current = interim;
    if (interimTimerRef.current !== null) return;
    interimTimerRef.current = window.setTimeout(() => {
      interimTimerRef.current = null;
      setInterimText(pendingInterimRef.current);
    }, INTERIM_THROTTLE_MS);
  }, []);

  /** 惰性创建识别实例 */
  const ensureRecognition = useCallback((): SpeechRecognitionLike | null => {
    if (recognitionRef.current) return recognitionRef.current;
    if (typeof window === 'undefined') return null;
    const w = window as SpeechRecognitionWindow;
    const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Ctor) return null;

    const recognition = new Ctor();
    recognition.lang = lang;
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (ev) => {
      // 有结果说明识别链路正常：刷新空闲时间戳并累计的重启次数清零
      lastResultAtRef.current = Date.now();
      restartCountRef.current = 0;

      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const result = ev.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) {
          const finalText = text.trim();
          if (finalText) onFinalRef.current?.(finalText);
        } else {
          interim += text;
        }
      }
      pushInterim(interim);
    };

    recognition.onerror = (ev) => {
      // 静音/主动中止属于连续识别的正常事件，不弹错误提示
      if (!BENIGN_ERRORS.has(ev.error)) {
        setError(ERROR_MESSAGES[ev.error] ?? `语音识别失败：${ev.error}`);
      }
      // 致命错误立即停止，避免进入无意义的重启循环
      if (FATAL_ERRORS.has(ev.error)) {
        canRestartRef.current = false;
        stopRef.current();
      }
    };

    recognition.onend = () => {
      // 非聆听态：正常收尾
      if (!listeningRef.current) {
        setListening(false);
        setInterimText('');
        return;
      }
      // 空闲过久：自动停止，避免“说完不管”时识别在后台常驻
      if (Date.now() - lastResultAtRef.current > IDLE_TIMEOUT_MS) {
        stopRef.current();
        return;
      }
      // 致命错误后或重启超限：停止聆听
      if (!canRestartRef.current || restartCountRef.current >= MAX_RESTARTS) {
        stopRef.current();
        return;
      }
      // 连续识别下浏览器会因静音自动结束，这里做「有上限 + 有间隔」的自动重启
      restartCountRef.current += 1;
      clearRestartTimer();
      restartTimerRef.current = window.setTimeout(() => {
        restartTimerRef.current = null;
        if (!listeningRef.current || !canRestartRef.current) return;
        try {
          recognition.start();
        } catch {
          // 重启失败说明实例已不可用，直接停止
          stopRef.current();
        }
      }, MIN_RESTART_DELAY_MS);
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [lang, pushInterim, clearRestartTimer]);

  const start = useCallback(() => {
    setError(null);
    const recognition = ensureRecognition();
    if (!recognition) {
      setError('当前浏览器不支持语音输入');
      return;
    }
    // 每次主动开始都重置重启配额与空闲计时
    clearRestartTimer();
    restartCountRef.current = 0;
    canRestartRef.current = true;
    lastResultAtRef.current = Date.now();
    listeningRef.current = true;
    setListening(true);
    try {
      recognition.start();
    } catch {
      /* 已在运行时忽略重复 start */
    }
  }, [ensureRecognition, clearRestartTimer]);

  const stop = useCallback(() => {
    listeningRef.current = false;
    canRestartRef.current = false;
    clearRestartTimer();
    clearInterimTimer();
    setListening(false);
    setInterimText('');
    try {
      recognitionRef.current?.stop();
    } catch {
      /* 未启动时忽略 */
    }
  }, [clearRestartTimer, clearInterimTimer]);

  // 保持稳定引用，供 onend / 定时器回调内部调用
  stopRef.current = stop;

  const toggle = useCallback(() => {
    if (listeningRef.current) stop();
    else start();
  }, [start, stop]);

  const reset = useCallback(() => {
    clearInterimTimer();
    setInterimText('');
    setError(null);
  }, [clearInterimTimer]);

  // 卸载时彻底停止识别并清理定时器，避免残留监听与后台循环
  useEffect(() => () => {
    listeningRef.current = false;
    canRestartRef.current = false;
    if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
    if (interimTimerRef.current !== null) window.clearTimeout(interimTimerRef.current);
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  return { supported, listening, interimText, error, start, stop, toggle, reset };
}

export default useSpeechInput;