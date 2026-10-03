/**
 * InstallPrompt – 移动端 PWA 安装引导横幅。
 *
 * 显示条件（三者同时满足）：移动端窄屏 && 未以独立窗口运行 && 用户未关闭过。
 * - Android/Chrome 等支持 beforeinstallprompt 的浏览器：点击「安装」直接弹出系统安装框；
 * - iOS Safari 不支持该事件：点击「安装」给出「分享 → 添加到主屏幕」的文字指引。
 *
 * 用户关闭后写入 localStorage，后续不再打扰。
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Download, Share, X } from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { useIsMobile, useIsStandalone } from '../hooks/useMobile';

/** 用户关闭安装引导的持久化键 */
const DISMISS_KEY = 'note_install_dismissed';

/** beforeinstallprompt 事件类型（TS 内置类型库未包含） */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * 判断是否为 iOS 设备（用于回退到手动安装指引）。
 * @returns 是否 iOS
 */
function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    && !(window as Window & { MSStream?: unknown }).MSStream;
}

const InstallPrompt: React.FC = () => {
  const { theme } = useApp();
  const isDark = theme === 'dark';
  const isMobile = useIsMobile();
  const isStandalone = useIsStandalone();

  /** 用户是否已关闭引导 */
  const [dismissed, setDismissed] = useState<boolean>(
    () => localStorage.getItem(DISMISS_KEY) === '1',
  );
  /** 已缓存的安装事件（支持的浏览器才有） */
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  /** 是否展开 iOS 手动安装指引 */
  const [showIOSHint, setShowIOSHint] = useState(false);

  useEffect(() => {
    /** 捕获安装事件，阻止默认迷你信息条，改由本组件按钮触发 */
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    /** 安装完成后不再提示 */
    const onInstalled = () => {
      localStorage.setItem(DISMISS_KEY, '1');
      setDismissed(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  /** 关闭引导并持久化 */
  const handleDismiss = useCallback(() => {
    localStorage.setItem(DISMISS_KEY, '1');
    setDismissed(true);
  }, []);

  /** 触发安装：有原生事件则弹系统框，否则展开 iOS 指引 */
  const handleInstall = useCallback(async () => {
    if (deferredPrompt) {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      setDeferredPrompt(null);
      if (choice.outcome === 'accepted') handleDismiss();
      return;
    }
    setShowIOSHint(true);
  }, [deferredPrompt, handleDismiss]);

  if (!isMobile || isStandalone || dismissed) return null;

  return (
    <div
      className={`border-b px-3 py-1.5 text-xs ${
        isDark ? 'border-sky-800 bg-sky-950/60 text-sky-200' : 'border-sky-200 bg-sky-50 text-sky-700'
      }`}
    >
      <div className="flex items-center gap-2">
        <Download size={14} className="shrink-0" />
        <span className="flex-1">安装到主屏，离线也能用</span>
        <button
          type="button"
          onClick={() => void handleInstall()}
          className="shrink-0 rounded px-2 py-0.5 font-medium underline underline-offset-2"
        >
          安装
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="shrink-0 opacity-60 hover:opacity-100"
          title="关闭"
        >
          <X size={13} />
        </button>
      </div>

      {showIOSHint && (
        <p className="mt-1 flex items-start gap-1.5 opacity-90">
          <Share size={12} className="mt-0.5 shrink-0" />
          <span>在 Safari 中点击底部「分享」按钮，选择「添加到主屏幕」即可安装。</span>
        </p>
      )}
    </div>
  );
};

export default InstallPrompt;