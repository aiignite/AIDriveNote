/**
 * NoteCommandPalette – 笔记命令面板（⌘K / Ctrl+K）
 *
 * 汇总面板命令与编辑器注册命令，按标签 + 关键词做前缀优先过滤，
 * 支持 ↑↓ 选择、Enter 执行、Esc 关闭，每项展示快捷键提示。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { formatShortcut, type NoteCommand } from '../../utils/noteCommands';

interface NoteCommandPaletteProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 可选命令集合（面板命令 + 编辑器命令） */
  commands: NoteCommand[];
  /** 暗色主题 */
  isDark?: boolean;
}

const NoteCommandPalette: React.FC<NoteCommandPaletteProps> = ({
  open,
  onClose,
  commands,
  isDark = false,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // 打开时重置查询并聚焦
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  /** 前缀优先 + 子串匹配的简单过滤（不做模糊排序算法） */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = commands.map(cmd => ({
      cmd,
      enabled: cmd.isEnabled ? cmd.isEnabled() : true,
    }));
    if (!q) return list;

    const prefix: typeof list = [];
    const contains: typeof list = [];
    for (const item of list) {
      const label = item.cmd.label.toLowerCase();
      const keywords = (item.cmd.keywords ?? '').toLowerCase();
      if (label.startsWith(q) || keywords.startsWith(q)) prefix.push(item);
      else if (label.includes(q) || keywords.includes(q) || item.cmd.id.toLowerCase().includes(q)) contains.push(item);
    }
    return [...prefix, ...contains];
  }, [commands, query]);

  // 过滤结果变化时把高亮重置到第一项
  useEffect(() => {
    setActiveIndex(prev => (prev >= filtered.length ? 0 : prev));
  }, [filtered.length]);

  // 高亮项滚动进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const runAt = (index: number) => {
    const item = filtered[index];
    if (!item || !item.enabled) return;
    onClose();
    void item.cmd.run();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] bg-black/30"
      onClick={onClose}
    >
      <div
        className={`w-[520px] max-w-[92vw] rounded-xl border shadow-2xl overflow-hidden ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center gap-2 px-3 py-2.5 border-b ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
          <Search size={14} className={isDark ? 'text-gray-500' : 'text-gray-400'} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(prev => Math.min(prev + 1, filtered.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(prev => Math.max(prev - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runAt(activeIndex);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="输入命令名称，如「表格」「导出」「撤销」…"
            className={`flex-1 text-sm outline-none bg-transparent ${
              isDark ? 'text-gray-100 placeholder-gray-600' : 'text-gray-800 placeholder-gray-400'
            }`}
          />
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${isDark ? 'border-gray-600 text-gray-500' : 'border-gray-200 text-gray-400'}`}>
            Esc
          </span>
        </div>

        <div ref={listRef} className="max-h-[52vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className={`px-4 py-6 text-center text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              没有匹配的命令
            </p>
          ) : filtered.map((item, index) => (
            <button
              key={item.cmd.id}
              type="button"
              data-index={index}
              disabled={!item.enabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => runAt(index)}
              className={`w-full flex items-center gap-3 px-4 py-2 text-left text-xs transition-colors ${
                !item.enabled
                  ? (isDark ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 cursor-not-allowed')
                  : index === activeIndex
                    ? (isDark ? 'bg-gray-700 text-white' : 'bg-orange-50 text-orange-700')
                    : (isDark ? 'text-gray-300' : 'text-gray-700')
              }`}
            >
              <span className={`flex-1 truncate ${item.cmd.danger && item.enabled ? 'text-red-500 dark:text-red-400' : ''}`}>
                {item.cmd.label}
              </span>
              {item.cmd.shortcut && (
                <span className={`shrink-0 text-[10px] tabular-nums ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {formatShortcut(item.cmd.shortcut)}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default NoteCommandPalette;