/**
 * 焦点陷阱（focus trap）—— 用于命令面板、快速切换器、确认弹窗等模态容器。
 *
 * 为什么需要：模态弹窗打开后，Tab 若能移到背后的页面元素上，用户会失去位置感，
 * 屏幕阅读器也会读出无关内容。标准做法是把焦点限制在弹窗内，关闭后归还给触发元素。
 *
 * 实现遵循 WAI-ARIA 弹窗模式：
 * 1. 打开时把焦点移入弹窗（优先带 autofocus 的元素，否则容器本身）；
 * 2. Tab / Shift+Tab 在循环焦点元素之间移动，到边界后回绕；
 * 3. 卸载时把焦点还给打开前的那个元素。
 */
import { useEffect, type RefObject } from 'react';

/** 可聚焦元素选择器：涵盖链接、按钮、表单控件与可编辑区域 */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * 把焦点限制在给定容器内。
 * @param ref 弹窗容器 ref
 * @param active 是否处于打开状态；关闭时跳过
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    // 记录打开前的焦点，关闭后归还
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // 打开时聚焦：优先 autofocus，其次第一个可聚焦元素，最后退化为容器本身
    const initial =
      container.querySelector<HTMLElement>('[autofocus]')
      ?? container.querySelector<HTMLElement>(FOCUSABLE)
      ?? container;
    // 容器本身不可聚焦时临时加上 tabindex，让它能接住焦点
    if (initial === container && !container.hasAttribute('tabindex')) {
      container.setAttribute('tabindex', '-1');
    }
    initial.focus();

    /**
     * 在容器内循环移动焦点。
     * @param e 键盘事件
     */
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        el => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement as HTMLElement | null;

      if (!e.shiftKey && (current === last || !container.contains(current))) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (current === first || !container.contains(current))) {
        e.preventDefault();
        last.focus();
      }
    };

    // 捕获阶段监听，确保在弹窗内元素的处理器之前拿到 Tab
    container.addEventListener('keydown', onKeyDown, true);

    return () => {
      container.removeEventListener('keydown', onKeyDown, true);
      // 归还焦点；元素可能已从 DOM 移除，需判空
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [ref, active]);
}