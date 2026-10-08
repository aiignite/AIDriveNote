/**
 * RecordingStatusDot.tsx — 录音菜单按钮上的极小状态标记
 *
 * 菜单按钮本身保持原尺寸，只在麦克风图标右下角叠加一个 ~6px 的小圆点，
 * 用来提示「录音中 / 转写中 / 已完成 / 失败」，避免为此弹出一整块面板。
 */
import React from 'react';

/** 标记状态 */
export type RecordingDotState = 'idle' | 'recording' | 'processing' | 'done' | 'failed';

/** 各状态的圆点样式 */
const DOT_CLASS: Record<RecordingDotState, string> = {
  idle: '',
  recording: 'bg-rose-500',
  processing: 'bg-amber-400',
  done: 'bg-emerald-500',
  failed: 'bg-rose-500',
};

interface RecordingStatusDotProps {
  /** 标记状态 */
  state: RecordingDotState;
  /** 状态说明（作为 title 展示） */
  label?: string;
}

const DOT_LABEL: Record<RecordingDotState, string> = {
  idle: '',
  recording: '正在录音',
  processing: '转写处理中',
  done: '转写已完成',
  failed: '转写失败',
};

/**
 * 录音状态小圆点。
 * @param props 组件属性
 * @returns 叠加在图标右下角的小圆点；idle 时返回 null
 */
export const RecordingStatusDot: React.FC<RecordingStatusDotProps> = ({ state, label }) => {
  if (state === 'idle') return null;
  return (
    <span
      aria-hidden
      title={label || DOT_LABEL[state]}
      className={`absolute -bottom-0.5 -right-0.5 block h-1.5 w-1.5 rounded-full ring-2 ring-white dark:ring-gray-900 ${
        DOT_CLASS[state]
      } ${state === 'recording' ? 'animate-pulse' : ''}`}
    />
  );
};

export default RecordingStatusDot;