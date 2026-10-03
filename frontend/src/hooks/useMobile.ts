/**
 * useMobile – 移动端与 PWA 显示模式检测。
 *
 * 提供两个 hooks：
 * - useIsMobile：按视口宽度判定是否为移动端布局（窄屏），供布局分支使用；
 * - useIsStandalone：判定应用是否以「已安装的独立窗口」运行（PWA）。
 *
 * 为什么用原生 matchMedia 而非引入设备检测库：断点与显示模式都能由浏览器
 * 媒体查询可靠表达，无需新增依赖；且布局分支是 JS 驱动的（选中笔记、宽度状态等），
 * 纯 CSS 媒体查询无法覆盖。
 */
import { useEffect, useState } from 'react';

/** 移动端断点（最大宽度），与 Tailwind 默认 md（768px 起）对齐 */
export const MOBILE_BREAKPOINT = 767;

/** 移动端媒体查询串 */
const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT}px)`;

/** 独立窗口（已安装 PWA）媒体查询串 */
const STANDALONE_QUERY = '(display-mode: standalone)';

/** 粗指针媒体查询串（手指触摸的主要特征） */
const COARSE_POINTER_QUERY = '(pointer: coarse)';

/**
 * 订阅一个媒体查询的匹配状态。
 * @param query 媒体查询串
 * @returns 当前是否匹配；无 window / matchMedia 环境返回 false
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    /** 媒体查询命中状态变化时同步到 state */
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}

/**
 * 当前视口是否应使用移动端（窄屏）布局。
 * @returns 是否移动端
 */
export function useIsMobile(): boolean {
  return useMediaQuery(MOBILE_QUERY);
}

/**
 * 当前设备是否具备触摸输入能力。
 *
 * 用于按「输入方式」而非「屏幕宽度」决定第三方编辑器的手势模式：
 * 横屏手机宽度可超过移动端断点，而触屏笔记本宽度很大却同样支持触摸。
 * 判定以粗指针（手指）为主，并以 navigator.maxTouchPoints 兜底。
 * @returns 是否触摸设备
 */
export function useIsTouchDevice(): boolean {
  const coarsePointer = useMediaQuery(COARSE_POINTER_QUERY);
  const hasTouchPoints =
    typeof navigator !== 'undefined' && (navigator.maxTouchPoints ?? 0) > 0;
  return coarsePointer || hasTouchPoints;
}

/**
 * 当前是否以已安装的独立窗口（PWA standalone）运行。
 * iOS Safari 不暴露 display-mode，需回退到 navigator.standalone。
 * @returns 是否独立窗口运行
 */
export function useIsStandalone(): boolean {
  const standaloneByDisplay = useMediaQuery(STANDALONE_QUERY);
  const fullscreenByDisplay = useMediaQuery('(display-mode: fullscreen)');
  const [legacyStandalone, setLegacyStandalone] = useState<boolean>(() => {
    if (typeof navigator === 'undefined') return false;
    return (navigator as Navigator & { standalone?: boolean }).standalone === true;
  });

  // navigator.standalone 不会触发事件，仅在挂载时读取一次即可
  useEffect(() => {
    if (typeof navigator === 'undefined') return;
    setLegacyStandalone((navigator as Navigator & { standalone?: boolean }).standalone === true);
  }, []);

  return standaloneByDisplay || fullscreenByDisplay || legacyStandalone;
}