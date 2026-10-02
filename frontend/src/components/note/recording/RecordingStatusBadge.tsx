/**
 * RecordingStatusBadge.tsx — 录音处理状态徽标
 *
 * 由会议版 RecordingStatusBadge 去会议化移植：展示 Uploaded / Transcribing /
 * Transcribed / Failed 四种状态，处理中额外显示进度条，失败时展示原因。
 */
import React from 'react';
import { Loader2, CheckCircle2, Upload, AlertCircle } from 'lucide-react';

/** 录音状态取值 */
export type RecordingStatus = 'Uploaded' | 'Transcribing' | 'Transcribed' | 'Failed';

interface RecordingStatusBadgeProps {
  /** 状态字符串 */
  status: string;
  /** 进度百分比 0-100 */
  progressPct?: number;
  /** 失败原因 */
  errorMessage?: string | null;
  /** 自定义类名 */
  className?: string;
}

/** 各状态的展示样式 */
const STATUS_STYLES: Record<RecordingStatus, { bg: string; text: string; label: string; icon: React.ReactNode }> = {
  Uploaded: { bg: 'bg-sky-50', text: 'text-sky-700', label: '已上传', icon: <Upload size={12} /> },
  Transcribing: { bg: 'bg-amber-50', text: 'text-amber-700', label: '转写中', icon: <Loader2 size={12} className="animate-spin" /> },
  Transcribed: { bg: 'bg-emerald-50', text: 'text-emerald-700', label: '已完成', icon: <CheckCircle2 size={12} /> },
  Failed: { bg: 'bg-rose-50', text: 'text-rose-700', label: '失败', icon: <AlertCircle size={12} /> },
};

/**
 * 录音状态徽标组件。
 * @param props 组件属性
 * @returns 状态徽标 + 进度条 + 失败提示
 */
export const RecordingStatusBadge: React.FC<RecordingStatusBadgeProps> = ({
  status,
  progressPct = 0,
  errorMessage,
  className,
}) => {
  const cfg = STATUS_STYLES[status as RecordingStatus] || STATUS_STYLES.Uploaded;
  const isInProgress = status === 'Uploaded' || status === 'Transcribing';
  return (
    <div className={className}>
      <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${cfg.bg} ${cfg.text}`}>
        {cfg.icon}
        {cfg.label}
        {isInProgress && progressPct > 0 && progressPct < 100 && (
          <span className="ml-1 opacity-70">{progressPct}%</span>
        )}
      </div>
      {isInProgress && (
        <div className="mt-1 h-1 w-full bg-gray-100 dark:bg-gray-700 rounded overflow-hidden">
          <div
            className="h-full bg-sky-500 transition-all"
            style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
          />
        </div>
      )}
      {status === 'Failed' && errorMessage && (
        <p className="mt-1 text-[11px] text-rose-600 break-all">{errorMessage}</p>
      )}
    </div>
  );
};

export default RecordingStatusBadge;