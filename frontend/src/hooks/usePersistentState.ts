/**
 * localStorage 持久化状态 —— 让筛选、排序、面板宽度等视图偏好跨刷新保留。
 *
 * 设计要点：
 * - 惰性初始化：useState 的初始函数只在首次挂载执行一次，避免每次渲染读存储；
 * - 容错解析：存储里可能是旧版本或被手工改坏的 JSON，解析失败一律回落默认值，
 *   不能因为一条脏数据就让整个列表页白屏；
 * - 隐私模式 / 存储被禁用时 setItem 会抛错，这里只吞不报；
 * - 写入合并：高频变化的字段（如搜索词）应传入 debounceMs，避免逐字符写盘。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 与 localStorage 双向同步的状态。
 * @param key 存储键，建议加 `note_` 前缀便于识别与清理
 * @param defaultValue 缺省值（也用作解析失败时的回落值）
 * @param validate 校验函数，返回 false 时视为无效数据并回落默认值
 */
export function usePersistentState<T>(
  key: string,
  defaultValue: T,
  validate?: (value: unknown) => value is T,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof localStorage === 'undefined') return defaultValue;
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      const parsed: unknown = JSON.parse(raw);
      if (validate && !validate(parsed)) return defaultValue;
      return parsed as T;
    } catch {
      // JSON 损坏或不可访问：回落默认值
      return defaultValue;
    }
  });

  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(key, JSON.stringify(state));
    } catch {
      /* 隐私模式或配额用尽：忽略，不影响主流程 */
    }
  }, [key, state]);

  return [state, setState];
}

/**
 * 同 usePersistentState，但写入前等待一段时间无新值再落盘。
 * 适用于搜索词这类高频输入，避免每次按键都写 localStorage。
 *
 * 也适用于拖拽类连续变更（如拖动分隔条调整面板宽度）——若每次 mousemove 都同步写盘，
 * 会在一秒内产生上百次 localStorage 写入。
 * @param key 存储键
 * @param defaultValue 缺省值
 * @param debounceMs 静默等待毫秒数
 */
export function usePersistentStateDebounced<T>(
  key: string,
  defaultValue: T,
  debounceMs = 400,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(() => {
    if (typeof localStorage === 'undefined') return defaultValue;
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? defaultValue : (JSON.parse(raw) as T);
    } catch {
      return defaultValue;
    }
  });

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (typeof localStorage === 'undefined') return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      try {
        localStorage.setItem(key, JSON.stringify(state));
      } catch {
        /* 忽略写入失败 */
      }
    }, debounceMs);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [key, state, debounceMs]);

  return [state, setState];
}

/**
 * 读取持久化键的原始字符串（供不需要 JSON 的场景，如 '1'/'0' 标记）。
 * @param key 存储键
 * @returns 原始字符串；不存在时返回 null
 */
export function readRaw(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * 写入持久化键的原始字符串。
 * @param key 存储键
 * @param value 原始值；传 null 表示删除该键
 */
export function writeRaw(key: string, value: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* 忽略写入失败 */
  }
}

/** 校验函数：值必须是字符串数组 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string');
}

/**
 * 夹取数字到给定区间，容忍存储中的非法数值。
 * @param value 候选值
 * @param min 下限
 * @param max 上限
 * @param fallback 非法时返回的默认值
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * 生成一个只读一次的布尔持久化状态。
 * @param key 存储键
 * @param fallback 默认值
 */
export function usePersistentFlag(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => (readRaw(key) === '1' ? true : readRaw(key) === '0' ? false : fallback));
  const set = useCallback((next: boolean) => {
    setValue(next);
    writeRaw(key, next ? '1' : '0');
  }, [key]);
  return [value, set];
}