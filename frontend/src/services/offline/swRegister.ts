/**
 * Service Worker 注册与更新管理。
 *
 * 要点：
 * - 只在生产构建、安全上下文（HTTPS / localhost）下注册，避免开发期干扰热更新；
 * - 注册路径与 scope 均基于 Vite 注入的 BASE_URL，兼容子路径部署（/note/）；
 * - 不自动跳过等待：发现新版本时只通知界面，由用户确认后刷新，避免打断正在进行的编辑。
 */

/** 新版本就绪时的回调类型 */
type UpdateHandler = () => void;

/** 当前注册到的新版本回调 */
let updateHandler: UpdateHandler | null = null;

/**
 * 当前环境是否支持 Service Worker。
 * @returns 是否支持
 */
export function isSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * 注册新版本就绪的回调。
 * @param handler 回调函数
 */
export function onUpdateAvailable(handler: UpdateHandler): void {
  updateHandler = handler;
}

/**
 * 注册 Service Worker。
 * 失败时静默降级为纯在线使用，不影响任何主流程。
 */
export async function registerServiceWorker(): Promise<void> {
  if (!import.meta.env.PROD) return;
  if (!isSupported() || !window.isSecureContext) return;

  const base = import.meta.env.BASE_URL || '/';
  try {
    const registration = await navigator.serviceWorker.register(`${base}sw.js`, { scope: base });

    registration.addEventListener('updatefound', () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener('statechange', () => {
        // 已有页面被旧 SW 控制时，installed 状态意味着这是一个「更新」而非首次安装
        if (installing.state === 'installed' && navigator.serviceWorker.controller) {
          updateHandler?.();
        }
      });
    });
  } catch {
    /* 注册失败（非安全上下文、浏览器禁用等）不影响在线使用 */
  }
}

/**
 * 应用新版本：让等待中的 SW 立即接管并刷新页面。
 */
export function applyUpdate(): void {
  navigator.serviceWorker.controller?.postMessage({ type: 'SKIP_WAITING' });
  window.location.reload();
}