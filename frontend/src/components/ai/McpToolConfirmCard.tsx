import React, { useState } from 'react';
import { Loader2, ShieldAlert, X } from 'lucide-react';
import toast from 'react-hot-toast';
import { mcpApi } from '../../services/mcp';
import type { McpPendingTool } from '../../hooks/useAIChat';

interface McpToolConfirmCardProps {
  pending: McpPendingTool;
  isDark: boolean;
}

/** MCP 工具确认卡：AI 想调用「需确认」策略的工具时，由用户决定是否执行。 */
const McpToolConfirmCard: React.FC<McpToolConfirmCardProps> = ({ pending, isDark }) => {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'dismissed'>('idle');
  const [result, setResult] = useState('');

  if (status === 'dismissed') return null;

  const handleRun = async () => {
    setStatus('running');
    try {
      const response = await mcpApi.callTool(pending.toolId, pending.arguments);
      const text = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response, null, 2);
      setResult(text.slice(0, 4000));
      setStatus('done');
      toast.success('MCP 工具已执行');
    } catch (error) {
      setStatus('idle');
      toast.error(error instanceof Error ? error.message : 'MCP 工具执行失败');
    }
  };

  return (
    <div className={`mt-3 rounded-xl border p-3 text-xs ${
      isDark ? 'border-amber-800 bg-amber-950/20' : 'border-amber-200 bg-amber-50/60'
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className={`flex items-center gap-1.5 font-medium ${isDark ? 'text-amber-300' : 'text-amber-800'}`}>
          <ShieldAlert size={13} />
          需要确认：调用 MCP 工具「{pending.tool}」
        </div>
        <button
          type="button"
          onClick={() => setStatus('dismissed')}
          className="shrink-0 text-gray-400 hover:text-gray-600"
          aria-label="忽略"
        >
          <X size={13} />
        </button>
      </div>
      <p className={`mt-1 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        来源：{pending.server} · 该工具被设置为「需确认」，不会由模型自动执行。
      </p>
      <pre className={`mt-2 max-h-28 overflow-auto rounded-lg p-2 text-[10px] ${
        isDark ? 'bg-gray-900 text-gray-300' : 'bg-white text-gray-600 border border-gray-200'
      }`}>
        {JSON.stringify(pending.arguments, null, 2)}
      </pre>
      {status === 'done' ? (
        <pre className={`mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg p-2 text-[10px] ${
          isDark ? 'bg-gray-900 text-gray-300' : 'bg-white text-gray-700 border border-gray-200'
        }`}>
          {result}
        </pre>
      ) : (
        <div className="mt-2 flex justify-end gap-2">
          <button
            type="button"
            onClick={() => setStatus('dismissed')}
            className="rounded-lg px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void handleRun()}
            disabled={status === 'running'}
            className="inline-flex items-center gap-1 rounded-lg bg-amber-600 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {status === 'running' && <Loader2 size={11} className="animate-spin" />}
            允许并执行
          </button>
        </div>
      )}
    </div>
  );
};

export default McpToolConfirmCard;
