/**
 * ToolCallDisplay — 展示一轮对话中工具的执行情况
 *
 * 顶部展示“工具执行 N 项”，逐条展示工具名称与执行状态（running/success/error）
 * 及结果摘要。running 态显示旋转图标。
 */
import React from 'react';
import { AlertTriangle, Check, Loader2, Wrench } from 'lucide-react';
import type { ToolCallEventItem } from '../../services/ai/ai';

interface ToolCallDisplayProps {
  /** 工具执行记录 */
  toolCalls: ToolCallEventItem[];
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 额外样式 */
  className?: string;
}

const ToolCallDisplay: React.FC<ToolCallDisplayProps> = ({
  toolCalls,
  isDark = false,
  className = '',
}) => {
  if (!toolCalls || toolCalls.length === 0) return null;

  return (
    <div
      className={`mb-2 rounded-lg border px-2.5 py-2 text-xs ${
        isDark ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-gray-50'
      } ${className}`}
    >
      <div className={`mb-1.5 flex items-center gap-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        <Wrench size={12} />
        <span>工具执行 {toolCalls.length} 项</span>
      </div>
      <div className="space-y-1">
        {toolCalls.map((tc, idx) => (
          <div key={`${tc.name}-${idx}`} className="flex items-start gap-1.5">
            <span className="mt-0.5 shrink-0">
              {tc.status === 'running' && (
                <Loader2 size={12} className="animate-spin text-orange-500" />
              )}
              {tc.status === 'success' && <Check size={12} className="text-green-500" />}
              {tc.status === 'error' && <AlertTriangle size={12} className="text-red-500" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className={`font-mono ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                {tc.name}
              </span>
              {tc.message && (
                <span className={`ml-1.5 ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {tc.message}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ToolCallDisplay;