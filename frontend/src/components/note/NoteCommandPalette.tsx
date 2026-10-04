/**
 * NoteCommandPalette – 笔记命令面板（⌘K / Ctrl+K）
 *
 * 汇总面板命令与编辑器注册命令，支持模糊匹配与分组展示，
 * ↑↓ 选择、Enter 执行、Esc 关闭，每项展示快捷键提示。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { formatShortcut, MENU_GROUP_LABEL, type NoteCommand } from '../../utils/noteCommands';

/** 分组标题的展示顺序（与菜单栏一致） */
const GROUP_ORDER = ['file', 'edit', 'insert', 'view', 'format', 'help'] as const;

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

/**
 * 模糊匹配打分：支持子序列匹配（如「导pdf」命中「导出为 PDF」）。
 * 返回分数，越大越靠前；不匹配返回 -1。
 *
 * 比原先的纯前缀/子串匹配好在：中文命令名往往较长，用户只会记得其中几个字，
 * 子序列匹配能让「大纲」命中「显示大纲」，「撤销」命中「撤销重做」。
 *
 * @param haystack 待匹配文本（已转小写）
 * @param needle 查询词（已转小写）
 * @returns 匹配分数，-1 表示不匹配
 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  if (haystack.startsWith(needle)) return 1000 - haystack.length;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 600 - direct - haystack.length;

  // 子序列匹配：按顺序命中每个字符，跨度越小分越高
  let hi = 0;
  let score = 0;
  let streak = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, hi);
    if (found === -1) return -1;
    streak = found === hi ? streak + 1 : 0;
    score += 10 + streak * 5 - (found - hi);
    hi = found + 1;
  }
  return score;
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
  const dialogRef = useRef<HTMLDivElement>(null);
  // 模态：焦点限制在弹窗内，关闭后归还给触发元素
  useFocusTrap(dialogRef, open);

  // 打开时重置查询并聚焦
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  /**
   * 模糊过滤 + 打分排序。
   * 命中文本（label/keywords/id）取最高分，并按所属分组做稳定排序。
   */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = commands
      .map(cmd => ({ cmd, enabled: cmd.isEnabled ? cmd.isEnabled() : true }))
      .map(item => {
        if (!q) return { ...item, score: 0 };
        const label = item.cmd.label.toLowerCase();
        const keywords = (item.cmd.keywords ?? '').toLowerCase();
        const id = item.cmd.id.toLowerCase();
        // 标题命中权重高于关键词与 id
        const score = Math.max(
          fuzzyScore(label, q),
          fuzzyScore(keywords, q) - 50,
          fuzzyScore(id, q) - 100,
        );
        return { ...item, score };
      })
      .filter(item => item.score >= 0);

    // 无查询时保持传入顺序；有查询时按分数降序（分数相同时保持原顺序，稳定排序）
    if (!q) return list;
    return list
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (b.item.score - a.item.score) || (a.index - b.index))
      .map(({ item }) => item);
  }, [commands, query]);

  /**
   * 把结果按命令 id 的分组前缀分组（'edit.undo' → 'edit'）。
   * 无查询时直接按 GROUP_ORDER 排布便于扫视；有查询时保持打分顺序，仅插入分组标题。
   */
  const groups = useMemo(() => {
    const items = filtered.map((item, index) => {
      const raw = item.cmd.id.split('.')[0];
      const group = (GROUP_ORDER as readonly string[]).includes(raw) ? raw : 'other';
      return { ...item, group, index };
    });

    if (!query.trim()) {
      // 无查询：严格按 GROUP_ORDER 分组
      const order = [...GROUP_ORDER, 'other'] as string[];
      return order
        .map(g => ({ group: g, items: items.filter(i => i.group === g) }))
        .filter(sec => sec.items.length > 0);
    }
    // 有查询：保持分数顺序，单一「结果」分组，避免频繁跳组
    return items.length ? [{ group: 'result', items }] : [];
  }, [filtered, query]);

  /** 展平后的可执行项顺序，与渲染顺序一致，供键盘上下键索引 */
  const flatItems = useMemo(() => groups.flatMap(sec => sec.items), [groups]);

  // 过滤结果变化时把高亮重置到第一项
  useEffect(() => {
    setActiveIndex(prev => (prev >= flatItems.length ? 0 : prev));
  }, [flatItems.length]);

  // 高亮项滚动进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const runAt = (index: number) => {
    const item = flatItems[index];
    if (!item || !item.enabled) return;
    onClose();
    void item.cmd.run();
  };

  /** 分组标题文案 */
  const groupLabel = (g: string) => {
    if (g === 'other') return '其他';
    if (g === 'result') return '搜索结果';
    return MENU_GROUP_LABEL[g as keyof typeof MENU_GROUP_LABEL] ?? g;
  };

  let cursor = 0;
  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center pt-[12vh] bg-black/30"
      onClick={onClose}
    >
      <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
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
                setActiveIndex(prev => Math.min(prev + 1, flatItems.length - 1));
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
            placeholder="输入命令名称，如「表格」「导出 pdf」「撤销」…"
            className={`flex-1 text-sm outline-none bg-transparent ${
              isDark ? 'text-gray-100 placeholder-gray-600' : 'text-gray-800 placeholder-gray-400'
            }`}
          />
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${isDark ? 'border-gray-600 text-gray-500' : 'border-gray-200 text-gray-400'}`}>
            Esc
          </span>
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label="命令列表"
          className="max-h-[52vh] overflow-y-auto py-1"
        >
          {flatItems.length === 0 ? (
            <p className={`px-4 py-6 text-center text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              没有匹配的命令
            </p>
          ) : (
            groups.map(section => (
              <div key={section.group}>
                {/* 分组标题 */}
                <div className={`px-4 pt-2 pb-1 text-[10px] font-medium tracking-wide ${
                  isDark ? 'text-gray-500' : 'text-gray-400'
                }`}>
                  {groupLabel(section.group)}
                </div>
                {section.items.map(item => {
                  const index = cursor++;
                  return (
                    <button
                      key={item.cmd.id}
                      type="button"
                      role="option"
                      aria-selected={index === activeIndex}
                      aria-disabled={!item.enabled}
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
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default NoteCommandPalette;