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

    // 首屏空闲后后台预热非首屏资源，兼顾离线可用性与首屏速度
    scheduleCacheWarm();
  } catch {
    /* 注册失败（非安全上下文、浏览器禁用等）不影响在线使用 */
  }
}

/**
 * 首屏加载完成、浏览器空闲时，通知 SW 后台预热非首屏资源。
 *
 * 为什么不在安装期一次性预缓存：全部产物合计 3 MB 以上（懒加载页面、编辑器、
 * KaTeX 字体、导出模块），安装期下载会与首屏请求争抢同一条链路，
 * 弱网下首屏被拖到几十秒。改到 load 之后的空闲时段串行预热，
 * 既不阻塞首屏，又能在用户真正断网前把离线资源补齐。
 */
function scheduleCacheWarm(): void {
  /**
   * 在浏览器空闲时执行回调；不支持 requestIdleCallback 时退化为定时器。
   * @param callback 待执行回调
   */
  const onIdle = (callback: () => void): void => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(callback, { timeout: 5000 });
    } else {
      window.setTimeout(callback, 3000);
    }
  };

  /** 向当前生效的 SW 发送预热指令 */
  const send = async (): Promise<void> => {
    try {
      const ready = await navigator.serviceWorker.ready;
      // 首次安装时页面尚未被接管，需回退到 active 实例
      const target = navigator.serviceWorker.controller ?? ready.active;
      target?.postMessage({ type: 'WARM_CACHE' });
    } catch {
      /* 预热失败不影响在线使用 */
    }
  };

  if (document.readyState === 'complete') {
    onIdle(() => void send());
  } else {
    window.addEventListener('load', () => onIdle(() => void send()), { once: true });
  }
}

/**
 * 应用新版本：让等待中的 SW 立即接管并刷新页面。
 */
export function applyUpdate(): void {
  navigator.serviceWorker.controller?.postMessage({ type: 'SKIP_WAITING' });
  window.location.reload();
}