/**
 * useSpeechInput — 浏览器原生语音输入 Hook（Web Speech API）
 *
 * 封装 SpeechRecognition / webkitSpeechRecognition，用于把麦克风语音实时转成文字。
 * 与既有笔记录音（AudioRecorder）链路相互独立：本 Hook 只做“语音转文字”，
 * 不涉及音频采集、上传与后端转写，因此零后端改动。
 *
 * 注意：Web Speech API 仅在安全上下文（https / localhost）可用；不支持时
 * supported 为 false，调用方应禁用入口并给出提示。
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

  const [listening, setListening] = useState(false);
  const [interimText, setInterimText] = useState('');
  const [error, setError] = useState<string | null>(null);

  const supported = typeof window !== 'undefined'
    && Boolean(
      (window as SpeechRecognitionWindow).SpeechRecognition
      || (window as SpeechRecognitionWindow).webkitSpeechRecognition,
    )
    && (typeof window === 'undefined' || window.isSecureContext !== false);

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
      setInterimText(interim);
    };

    recognition.onerror = (ev) => {
      setError(ERROR_MESSAGES[ev.error] ?? `语音识别失败：${ev.error}`);
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        listeningRef.current = false;
        setListening(false);
      }
    };

    recognition.onend = () => {
      // 连续识别下浏览器会因静音自动结束，这里按需自动重启
      if (listeningRef.current) {
        try {
          recognition.start();
          return;
        } catch {
          /* 重启失败则视为停止 */
        }
      }
      listeningRef.current = false;
      setListening(false);
      setInterimText('');
    };

    recognitionRef.current = recognition;
    return recognition;
  }, [lang]);

  const start = useCallback(() => {
    setError(null);
    const recognition = ensureRecognition();
    if (!recognition) {
      setError('当前浏览器不支持语音输入');
      return;
    }
    listeningRef.current = true;
    setListening(true);
    try {
      recognition.start();
    } catch {
      /* 已在运行时忽略重复 start */
    }
  }, [ensureRecognition]);

  const stop = useCallback(() => {
    listeningRef.current = false;
    setListening(false);
    setInterimText('');
    try {
      recognitionRef.current?.stop();
    } catch {
      /* 未启动时忽略 */
    }
  }, []);

  const toggle = useCallback(() => {
    if (listeningRef.current) stop();
    else start();
  }, [start, stop]);

  const reset = useCallback(() => {
    setInterimText('');
    setError(null);
  }, []);

  // 卸载时停止识别，避免残留监听
  useEffect(() => () => {
    listeningRef.current = false;
    try {
      recognitionRef.current?.stop();
    } catch {
      /* ignore */
    }
  }, []);

  return { supported, listening, interimText, error, start, stop, toggle, reset };
}

export default useSpeechInput;