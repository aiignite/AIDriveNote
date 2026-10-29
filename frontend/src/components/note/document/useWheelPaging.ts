/**
 * 鼠标滚轮 / 触控板翻页。
 *
 * 规则：
 * - 容器自身还能滚动时优先滚动，滚到边缘才翻页；
 * - 整页已完整显示（没有可滚动空间）时，滚轮直接翻页；
 * - 按“手势”计数：一次连续滚动只翻一页，避免触控板惯性一次跳过很多页；
 * - Ctrl / Cmd + 滚轮与横向滚动交给浏览器，不拦截。
 *
 * 必须用原生 non-passive 监听：React 的 onWheel 在部分浏览器里是 passive 的，
 * 无法在翻页时阻止父级页面继续滚动。
 */
import { useEffect, useRef } from 'react';

export interface WheelPagingOptions {
  /** 当前是否还能向该方向翻页 */
  canGo: (direction: 1 | -1) => boolean;
  /** 执行翻页 */
  go: (direction: 1 | -1) => void;
}

/** 一次手势累计多少像素触发翻页 */
const WHEEL_THRESHOLD = 60;
/** 多久没有滚轮事件视为新手势 */
const GESTURE_GAP_MS = 160;
/** 可滚动余量小于该值视为已到边缘 */
const SCROLL_EDGE_PX = 4;
/** 单行滚轮事件换算成像素的近似值 */
const LINE_HEIGHT_PX = 16;

/**
 * 给可滚动容器绑定滚轮翻页。
 * @param ref 翻页容器（同时作为滚动容器）
 * @param options 翻页判定与回调
 */
export function useWheelPaging<T extends HTMLElement>(
  ref: React.RefObject<T | null>,
  options: WheelPagingOptions,
): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let accumulated = 0;
    let lastDirection: 1 | -1 = 1;
    let lastEventAt = 0;
    let fired = false;

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;

      const direction: 1 | -1 = event.deltaY > 0 ? 1 : -1;
      if (!optionsRef.current.canGo(direction)) return;

      const maxScroll = element.scrollHeight - element.clientHeight;
      const canScroll =
        direction > 0
          ? element.scrollTop < maxScroll - SCROLL_EDGE_PX
          : element.scrollTop > SCROLL_EDGE_PX;
      if (canScroll) {
        // 让原生滚动继续；同时结束当前手势，避免滚到边缘后立即误翻页
        accumulated = 0;
        lastEventAt = 0;
        fired = false;
        return;
      }

      event.preventDefault();
      const now = performance.now();
      if (now - lastEventAt > GESTURE_GAP_MS) {
        accumulated = 0;
        fired = false;
      }
      lastEventAt = now;

      if (direction !== lastDirection) {
        accumulated = 0;
        fired = false;
        lastDirection = direction;
      }
      if (fired) return;

      const delta =
        event.deltaMode === 1
          ? event.deltaY * LINE_HEIGHT_PX
          : event.deltaMode === 2
            ? event.deltaY * element.clientHeight
            : event.deltaY;
      accumulated += delta;
      if (Math.abs(accumulated) < WHEEL_THRESHOLD) return;

      accumulated = 0;
      fired = true;
      optionsRef.current.go(direction);
    };

    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [ref]);
}
