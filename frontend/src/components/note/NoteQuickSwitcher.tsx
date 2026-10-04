/**
 * NoteQuickSwitcher – 笔记快速切换器（⌘P / Ctrl+P）
 *
 * 与命令面板（⌘K）职责分离：
 * - ⌘K 管「操作」：执行命令、切换视图、导出；
 * - ⌘P 管「定位」：按标题快速跳到某篇笔记。
 * 两者混用会让命令列表被笔记刷屏，因此单独实现。
 *
 * 匹配沿用命令面板的模糊子序列算法，输入几个字即可命中长标题。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Code2, Brain, GitFork } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { Note } from '../../services/note';

interface NoteQuickSwitcherProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 候选笔记 */
  notes: Note[];
  /** 当前打开的笔记 ID */
  selectedNoteId: string | null;
  /** 选中某篇笔记 */
  onSelect: (note: Note) => void;
  /** 暗色主题 */
  isDark?: boolean;
}

/** 笔记类型图标，与列表保持一致 */
const TYPE_ICON: Record<string, React.ReactNode> = {
  rich_text: <FileText size={13} />,
  markdown: <Code2 size={13} />,
  mindmap: <Brain size={13} />,
  flowchart: <GitFork size={13} />,
};

const TYPE_COLOR: Record<string, string> = {
  rich_text: 'text-orange-500',
  markdown: 'text-green-600',
  mindmap: 'text-purple-600',
  flowchart: 'text-orange-600',
};

/**
 * 模糊子序列打分：前缀 > 子串 > 子序列，返回 -1 表示不匹配。
 * @param haystack 待匹配文本（小写）
 * @param needle 查询词（小写）
 */
function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 0;
  if (haystack.startsWith(needle)) return 1000 - haystack.length;
  const direct = haystack.indexOf(needle);
  if (direct >= 0) return 600 - direct - haystack.length;

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

const NoteQuickSwitcher: React.FC<NoteQuickSwitcherProps> = ({
  open,
  onClose,
  notes,
  selectedNoteId,
  onSelect,
  isDark = false,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  // 模态：焦点限制在弹窗内，关闭后归还给触发元素
  useFocusTrap(dialogRef, open);

  // 打开时重置并聚焦
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  /** 过滤 + 打分；空查询时按更新时间倒序取最近的一批 */
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const scored = notes
      .map(note => {
        if (!q) return { note, score: 0 };
        const title = note.title.toLowerCase();
        // 标题命中权重最高，描述/编号次之（编号便于按 NT2026000001 精确定位）
        const score = Math.max(
          fuzzyScore(title, q),
          fuzzyScore((note.description ?? '').toLowerCase(), q) - 200,
          fuzzyScore((note.noteNo ?? '').toLowerCase(), q) - 100,
        );
        return { note, score };
      })
      .filter(item => item.score >= 0);

    return scored
      .map((item, index) => ({ item, index }))
      .sort((a, b) => (b.item.score - a.item.score) || (a.index - b.index))
      .map(({ item }) => item.note);
  }, [notes, query]);

  // 限制渲染数量：几百条全部渲染反而拖慢响应
  const visible = results.slice(0, 50);

  useEffect(() => {
    setActiveIndex(prev => (prev >= visible.length ? 0 : prev));
  }, [visible.length]);

  // 高亮项滚动进视野
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const choose = (index: number) => {
    const note = visible[index];
    if (!note) return;
    onClose();
    onSelect(note);
  };

  return (
    <div
      className="fixed inset-0 z-[61] flex items-start justify-center pt-[14vh] bg-black/30"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="快速跳转到笔记"
        className={`w-[460px] max-w-[92vw] rounded-xl border shadow-2xl overflow-hidden ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={e => e.stopPropagation()}
      >
        <div className={`flex items-center gap-2 px-3 py-2.5 border-b ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setActiveIndex(prev => Math.min(prev + 1, visible.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setActiveIndex(prev => Math.max(prev - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(activeIndex);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="跳转到笔记…"
            className={`flex-1 text-sm outline-none bg-transparent ${
              isDark ? 'text-gray-100 placeholder-gray-600' : 'text-gray-800 placeholder-gray-400'
            }`}
          />
          <span className={`shrink-0 text-[10px] tabular-nums ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {query ? `${visible.length}` : `${visible.length}`} 篇
          </span>
        </div>

        <div
          ref={listRef}
          role="listbox"
          aria-label="笔记列表"
          className="max-h-[52vh] overflow-y-auto py-1"
        >
          {visible.length === 0 ? (
            <p className={`px-4 py-6 text-center text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              没有匹配的笔记
            </p>
          ) : (
            visible.map((note, index) => {
              const isCurrent = note.id === selectedNoteId;
              return (
                <button
                  key={note.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-left text-xs transition-colors ${
                    index === activeIndex
                      ? (isDark ? 'bg-gray-700 text-white' : 'bg-orange-50 text-orange-700')
                      : (isDark ? 'text-gray-300' : 'text-gray-700')
                  }`}
                >
                  <span className={`shrink-0 ${TYPE_COLOR[note.noteType] ?? 'text-gray-400'}`}>
                    {TYPE_ICON[note.noteType] ?? <FileText size={13} />}
                  </span>
                  <span className="flex-1 truncate">
                    {note.title || '无标题'}
                    {isCurrent && (
                      <span className={`ml-1.5 text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        当前
                      </span>
                    )}
                  </span>
                  {note.noteNo && (
                    <span className={`shrink-0 text-[10px] tabular-nums ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>
                      {note.noteNo}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>

        {results.length > visible.length && (
          <div className={`px-3 py-1.5 border-t text-[10px] ${
            isDark ? 'border-gray-700 text-gray-500' : 'border-gray-100 text-gray-400'
          }`}>
            还有 {results.length - visible.length} 篇匹配，继续输入以缩小范围
          </div>
        )}
      </div>
    </div>
  );
};

export default NoteQuickSwitcher;