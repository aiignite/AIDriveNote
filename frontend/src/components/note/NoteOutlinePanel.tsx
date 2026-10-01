/**
 * NoteOutlinePanel – 笔记大纲（目录）侧栏
 *
 * 供富文本与 Markdown 使用：列出 H1-H6 标题，点击跳转到对应位置。
 * 由面板「视图 → 显示大纲」控制显隐，条目数据由编辑器上报。
 */
import React from 'react';
import { X } from 'lucide-react';
import type { NoteOutlineItem } from '../../utils/noteCommands';

interface NoteOutlinePanelProps {
  /** 大纲条目 */
  items: NoteOutlineItem[];
  /** 当前高亮条目 id */
  activeId?: string;
  /** 点击条目回调 */
  onSelect: (id: string) => void;
  /** 关闭侧栏 */
  onClose: () => void;
  /** 暗色主题 */
  isDark?: boolean;
}

const NoteOutlinePanel: React.FC<NoteOutlinePanelProps> = ({
  items,
  activeId,
  onSelect,
  onClose,
  isDark = false,
}) => (
  <aside
    className={`w-56 shrink-0 h-full flex flex-col border-l ${
      isDark ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-gray-50'
    }`}
  >
    <div className={`flex items-center justify-between px-3 py-2 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
      <span className={`text-xs font-semibold ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
        大纲
      </span>
      <button
        type="button"
        onClick={onClose}
        title="关闭大纲"
        className={`p-1 rounded ${isDark ? 'text-gray-500 hover:bg-gray-700' : 'text-gray-400 hover:bg-gray-200'}`}
      >
        <X size={13} />
      </button>
    </div>

    <div className="flex-1 overflow-y-auto py-1.5">
      {items.length === 0 ? (
        <p className={`px-3 py-4 text-[11px] leading-relaxed ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          暂无标题，使用 H1-H6 创建大纲
        </p>
      ) : items.map(item => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSelect(item.id)}
          title={item.text}
          style={{ paddingLeft: `${10 + (item.level - 1) * 10}px` }}
          className={`w-full block text-left pr-3 py-1 text-[11px] truncate transition-colors ${
            activeId === item.id
              ? (isDark ? 'bg-orange-900/30 text-orange-300' : 'bg-orange-50 text-orange-600')
              : (isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-200')
          }`}
        >
          {item.text}
        </button>
      ))}
    </div>
  </aside>
);

export default NoteOutlinePanel;