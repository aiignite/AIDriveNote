import { useCallback, useState } from 'react';

/**
 * 调起系统相机 / 相册选图（移植自 AIIgnitePLM useImageCapture）。
 *
 * 通过临时 <input type="file" capture> 实现：移动端直接拉起系统相机，
 * 桌面端退化为文件选择器，不依赖 getUserMedia，也无需 HTTPS 环境。
 *
 * 注意不要用短定时器在 window focus 后取消选择。相机应用通常会：
 * 1) input.click() 后立刻触发一次假 focus；
 * 2) 拍完回到页面时先触发 focus，change 事件还在编码中。
 * 提前移除 input 会静默丢掉刚拍的照片。
 */

export type ImageCaptureMode = 'environment' | 'user' | false;

export interface PickImageOptions {
  /** 优先后置相机；false = 仅相册 / 文件 */
  capture?: ImageCaptureMode;
  accept?: string;
  /** 允许多选（默认 false） */
  multiple?: boolean;
}

/** 从相机返回页面后，轮询等待 change 事件的最长宽限期（iOS 编码延迟） */
export const PICK_IMAGE_RETURN_GRACE_MS = 8_000;
export const PICK_IMAGE_POLL_INTERVAL_MS = 250;

/**
 * 打开系统文件选择器 / 相机，拍完或选完 resolve 出 File。
 * 用户取消时 resolve null。
 */
export function pickImage(options: PickImageOptions = {}): Promise<File | null> {
  const { capture = 'environment', accept = 'image/*', multiple = false } = options;

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) {
      input.setAttribute('capture', capture);
    }
    input.style.position = 'fixed';
    input.style.left = '-9999px';
    input.style.opacity = '0';

    let settled = false;
    let leftPage = false;
    let graceStarted = false;
    let graceTimer: number | null = null;
    let pollTimer: number | null = null;

    const finish = (file: File | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(file);
    };

    const firstFile = (): File | null => input.files?.[0] ?? null;

    const onChange = () => {
      finish(firstFile());
    };

    const onCancel = () => {
      finish(null);
    };

    const onBlur = () => {
      leftPage = true;
    };

    const startReturnGrace = () => {
      if (settled || graceStarted) return;
      graceStarted = true;
      const existing = firstFile();
      if (existing) {
        finish(existing);
        return;
      }

      const deadline = Date.now() + PICK_IMAGE_RETURN_GRACE_MS;
      const poll = () => {
        if (settled) return;
        const file = firstFile();
        if (file) {
          finish(file);
          return;
        }
        if (Date.now() >= deadline) {
          finish(null);
          return;
        }
        pollTimer = window.setTimeout(poll, PICK_IMAGE_POLL_INTERVAL_MS);
      };
      graceTimer = window.setTimeout(poll, PICK_IMAGE_POLL_INTERVAL_MS);
    };

    const onFocus = () => {
      // 忽略 click 后的合成 focus，仅页面真的失焦过（进了相机 / 系统选择器）才处理
      if (!leftPage) return;
      startReturnGrace();
    };

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        leftPage = true;
        return;
      }
      if (leftPage) startReturnGrace();
    };

    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      if (graceTimer != null) window.clearTimeout(graceTimer);
      if (pollTimer != null) window.clearTimeout(pollTimer);
      input.remove();
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    document.body.appendChild(input);
    input.click();
  });
}

/** {@link pickImage} 的 hook 封装，带进行中防重入 */
export function useImageCapture() {
  const [busy, setBusy] = useState(false);

  const capture = useCallback(async (options?: PickImageOptions): Promise<File | null> => {
    if (busy) return null;
    setBusy(true);
    try {
      return await pickImage(options);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  return { capture, pickImage, busy };
}
