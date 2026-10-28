/**
 * GlobalCommandPalette – 统一 ⌘K 面板
 *
 * 一个入口同时承担：笔记检索（服务端全文 + 命中高亮）、最近笔记快速定位、
 * 全局操作。编辑器专属命令通过「打开编辑器命令」再进入，避免两套面板抢同一个
 * 快捷键（旧实现里 ⌘K 同时绑定命令面板和插入链接）。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, FileText, Code2, Brain, GitFork, Command } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { noteApi, type Note, type NoteSearchResponse } from '../../services/note/note';

export interface PaletteAction {
  id: string;
  label: string;
  hint?: string;
  keywords?: string;
  run: () => void;
}

interface GlobalCommandPaletteProps {
  open: boolean;
  onClose: () => void;
  /** 当前列表里的笔记，用于空查询时的"最近"与离线兜底 */
  notes: Note[];
  selectedNoteId: string | null;
  onSelectNote: (note: Note) => void;
  actions: PaletteAction[];
  isDark?: boolean;
}

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

const SOURCE_LABEL: Record<string, string> = {
  email: '邮件',
  upload: '上传',
  clip: '剪藏',
  web_clip: '网页分享',
  mcp: 'Agent',
  note: '自写',
  kb: '知识库',
};

const KNOWLEDGE_TYPE_LABEL: Record<string, string> = {
  concept: '概念',
  entity: '实体',
  topic: '主题',
  decision: '决策',
  note: '笔记',
};

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

const GlobalCommandPalette: React.FC<GlobalCommandPaletteProps> = ({
  open,
  onClose,
  notes,
  selectedNoteId,
  onSelectNote,
  actions,
  isDark = false,
}) => {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [searchResult, setSearchResult] = useState<NoteSearchResponse | null>(null);
  const [searching, setSearching] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    setSearchResult(null);
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // 服务端全文检索（带高亮片段）；离线或失败时回落到本地标题过滤
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearchResult(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void noteApi.search(q, { limit: 8, include_shared: true })
        .then(result => { if (!cancelled) setSearchResult(result); })
        .catch(() => { if (!cancelled) setSearchResult(null); })
        .finally(() => { if (!cancelled) setSearching(false); });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const noteHits = useMemo<Note[]>(() => {
    const q = query.trim().toLowerCase();
    if (!q) return notes.slice(0, 8);
    if (searchResult) return searchResult.items;
    return notes
      .map(note => ({
        note,
        score: Math.max(
          fuzzyScore(note.title.toLowerCase(), q),
          fuzzyScore((note.description ?? '').toLowerCase(), q) - 200,
        ),
      }))
      .filter(item => item.score >= 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .map(item => item.note);
  }, [notes, query, searchResult]);

  const matchedActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter(action => {
      const haystack = `${action.label} ${action.keywords ?? ''} ${action.id}`.toLowerCase();
      return haystack.includes(q) || fuzzyScore(action.label.toLowerCase(), q) >= 0;
    });
  }, [actions, query]);

  const total = noteHits.length + matchedActions.length;

  useEffect(() => {
    setActiveIndex(prev => (prev >= total ? 0 : prev));
  }, [total]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  if (!open) return null;

  const runAt = (index: number) => {
    if (index < noteHits.length) {
      const note = noteHits[index];
      if (!note) return;
      onClose();
      onSelectNote(note);
      return;
    }
    const action = matchedActions[index - noteHits.length];
    if (!action) return;
    onClose();
    action.run();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex(prev => Math.min(prev + 1, Math.max(0, total - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex(prev => Math.max(prev - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      runAt(activeIndex);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  };

  const renderHighlight = (note: Note) => {
    const html = searchResult?.highlights?.[note.id];
    if (!html) return null;
    return (
      <p
        className={`mt-0.5 text-[11px] truncate [&_mark]:bg-amber-200 [&_mark]:text-amber-900 [&_mark]:rounded-sm [&_mark]:px-0.5 ${
          isDark ? 'text-gray-400 [&_mark]:bg-amber-500/30 [&_mark]:text-amber-100' : ''
        }`}
        // 服务端已做 HTML 转义后再插入 <mark>，此处只渲染受控片段
        dangerouslySetInnerHTML={{ __html: html }}
      />
    );
  };

  const renderKnowledge = (note: Note) => {
    const meta = searchResult?.knowledge?.[note.id];
    if (!meta) return null;
    return (
      <span className={`mt-1 flex flex-wrap items-center gap-1 text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
        {meta.sourceType && (
          <span className={`rounded px-1 py-0.5 ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
            {SOURCE_LABEL[meta.sourceType] || meta.sourceType}
          </span>
        )}
        {meta.knowledgeType && (
          <span className={`rounded px-1 py-0.5 ${isDark ? 'bg-gray-800' : 'bg-gray-100'}`}>
            {KNOWLEDGE_TYPE_LABEL[meta.knowledgeType] || meta.knowledgeType}
          </span>
        )}
        {meta.keywords.slice(0, 3).map((keyword) => (
          <span key={keyword}>#{keyword}</span>
        ))}
      </span>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[62] flex items-start justify-center pt-[12vh] bg-black/30"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="搜索与命令"
        className={`w-[560px] max-w-[92vw] rounded-xl border shadow-2xl overflow-hidden ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={event => event.stopPropagation()}
      >
        <div className={`flex items-center gap-2 px-3 py-2.5 border-b ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
          <Search size={14} className={isDark ? 'text-gray-500' : 'text-gray-400'} />
          <input
            ref={inputRef}
            value={query}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索笔记、执行操作…"
            className={`flex-1 text-sm outline-none bg-transparent ${
              isDark ? 'text-gray-100 placeholder-gray-600' : 'text-gray-800 placeholder-gray-400'
            }`}
          />
          <span className={`text-[10px] px-1.5 py-0.5 rounded border ${isDark ? 'border-gray-600 text-gray-500' : 'border-gray-200 text-gray-400'}`}>
            Esc
          </span>
        </div>

        <div ref={listRef} role="listbox" aria-label="搜索结果与命令" className="max-h-[56vh] overflow-y-auto py-1">
          {total === 0 ? (
            <p className={`px-4 py-6 text-center text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {searching ? '搜索中…' : '没有匹配的笔记或操作'}
            </p>
          ) : (
            <>
              <div className={`px-4 pt-2 pb-1 text-[10px] font-medium tracking-wide ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {query.trim() ? '笔记' : '最近笔记'}
              </div>
              {noteHits.map((note, index) => (
                <button
                  key={note.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeIndex}
                  data-index={index}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => runAt(index)}
                  className={`w-full flex items-start gap-2.5 px-4 py-2 text-left text-xs transition-colors ${
                    index === activeIndex
                      ? (isDark ? 'bg-gray-700 text-white' : 'bg-orange-50 text-orange-700')
                      : (isDark ? 'text-gray-300' : 'text-gray-700')
                  }`}
                >
                  <span className={`shrink-0 mt-0.5 ${TYPE_COLOR[note.noteType] ?? 'text-gray-400'}`}>
                    {TYPE_ICON[note.noteType] ?? <FileText size={13} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate">{note.title || '无标题'}</span>
                      {note.id === selectedNoteId && (
                        <span className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>当前</span>
                      )}
                    </span>
                    {renderHighlight(note)}
                    {!searchResult?.highlights?.[note.id] && searchResult?.knowledge?.[note.id]?.summary && (
                      <p className={`mt-0.5 text-[11px] truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                        {searchResult.knowledge[note.id].summary}
                      </p>
                    )}
                    {renderKnowledge(note)}
                  </span>
                  {note.noteNo && (
                    <span className={`shrink-0 text-[10px] tabular-nums ${isDark ? 'text-gray-600' : 'text-gray-300'}`}>
                      {note.noteNo}
                    </span>
                  )}
                </button>
              ))}

              {matchedActions.length > 0 && (
                <>
                  <div className={`px-4 pt-3 pb-1 text-[10px] font-medium tracking-wide ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    操作
                  </div>
                  {matchedActions.map((action, offset) => {
                    const index = noteHits.length + offset;
                    return (
                      <button
                        key={action.id}
                        type="button"
                        role="option"
                        aria-selected={index === activeIndex}
                        data-index={index}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => runAt(index)}
                        className={`w-full flex items-center gap-2.5 px-4 py-2 text-left text-xs transition-colors ${
                          index === activeIndex
                            ? (isDark ? 'bg-gray-700 text-white' : 'bg-orange-50 text-orange-700')
                            : (isDark ? 'text-gray-300' : 'text-gray-700')
                        }`}
                      >
                        <Command size={13} className={isDark ? 'text-gray-500' : 'text-gray-400'} />
                        <span className="flex-1 truncate">{action.label}</span>
                        {action.hint && (
                          <span className={`text-[10px] tabular-nums ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                            {action.hint}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default GlobalCommandPalette;
