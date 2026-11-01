import React, { useEffect, useState } from 'react';
import { Clock3, HardDrive, LogIn, Sparkles } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { authApi, type GuestQuota } from '../services/auth';
import ConfirmDialog from './ConfirmDialog';

const MB = 1024 * 1024;

function formatMb(bytes: number): string {
  return `${(bytes / MB).toFixed(bytes < 10 * MB ? 1 : 0)}MB`;
}

const GuestBanner: React.FC = () => {
  const { isGuest, logout } = useAuth();
  const location = useLocation();
  const [quota, setQuota] = useState<GuestQuota | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (!isGuest) return;
    let alive = true;
    void authApi.getGuestQuota()
      .then((next) => { if (alive) setQuota(next); })
      .catch(() => { /* 横幅保留静态说明即可 */ });
    return () => { alive = false; };
  }, [isGuest, location.pathname]);

  if (!isGuest) return null;

  const idleMinutes = quota?.idleTimeoutMinutes ?? 120;
  const storageText = quota
    ? `存储 ${formatMb(quota.storageUsedBytes)} / ${formatMb(quota.storageLimitBytes)}`
    : '存储额度 100MB';
  const skillText = quota ? `技能 ${quota.skillsUsed}/${quota.maxSkills}` : '技能上限 10';

  return (
    <>
      <div className="shrink-0 border-b border-orange-200/80 bg-orange-50 px-3 py-2 text-orange-900 safe-x dark:border-orange-900/50 dark:bg-orange-950/40 dark:text-orange-200">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5 font-semibold">
            <Sparkles size={14} className="text-orange-500" />
            匿名体验中
          </span>
          <span className="inline-flex items-center gap-1.5 text-orange-800/80 dark:text-orange-300/80">
            <Clock3 size={13} />
            {idleMinutes >= 60 ? `${idleMinutes / 60} 小时` : `${idleMinutes} 分钟`}无操作后自动清除
          </span>
          <span className="inline-flex items-center gap-1.5 text-orange-800/80 dark:text-orange-300/80">
            <HardDrive size={13} />
            {storageText}
          </span>
          <span className="inline-flex items-center gap-1.5 text-orange-800/80 dark:text-orange-300/80">
            <Sparkles size={13} />
            {skillText}
          </span>
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 font-semibold text-white hover:bg-orange-600"
          >
            <LogIn size={13} />
            登录 / 注册
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => {
          setConfirmOpen(false);
          logout();
        }}
        title="登录或注册会退出匿名模式"
        message="当前匿名数据会立即从服务器清除且无法恢复。确定继续吗？"
        confirmLabel="去登录"
        cancelLabel="继续体验"
        variant="info"
      />
    </>
  );
};

export default GuestBanner;
