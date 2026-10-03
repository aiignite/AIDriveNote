/**
 * ToolCallDisplay — 展示一轮对话中工具的执行情况
 *
 * 顶部展示“工具执行 N 项”，逐条展示工具名称与执行状态（running/success/error）
 * 及结果摘要。running 态显示旋转图标。工具名以中文标签展示，原始名放入 title。
 */
import React from 'react';
import { AlertTriangle, Check, Loader2, Wrench } from 'lucide-react';
import type { ToolCallEventItem } from '../../services/ai/ai';

/** 工具名 → 中文标签映射（缺失时回退为原始工具名） */
const TOOL_LABELS: Record<string, string> = {
  web_search: '联网搜索',
  list_notes: '查询笔记列表',
  get_note: '获取笔记详情',
  create_note: '创建笔记',
  update_note: '更新笔记',
  append_to_note: '追加内容',
  append_to_mindmap: '追加导图节点',
  delete_note: '删除笔记',
  list_note_folders: '列出文件夹',
  move_note_to_folder: '移动笔记',
  list_note_templates: '列出模板',
  create_note_from_template: '从模板创建笔记',
  list_note_tags: '列出标签',
  add_tags_to_note: '添加标签',
  batch_summarize_notes: '批量摘要',
  batch_add_tags: '批量添加标签',
};

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
              <span
                className={isDark ? 'text-gray-300' : 'text-gray-700'}
                title={tc.name}
              >
                {TOOL_LABELS[tc.name] ?? tc.name}
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