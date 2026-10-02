/**
 * ChatSkillPicker — 对话输入区的技能固定选择器
 *
 * 汇总现有笔记技能，支持搜索与手动固定（pin）。固定的技能 code 会随消息以
 * force_skills 下发，后端据此跳过自动匹配，直接激活指定技能，实现“所见即所得”。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search, Sparkles } from 'lucide-react';
import type { AISkill } from '../../services/ai/ai';

interface ChatSkillPickerProps {
  /** 可选技能列表（笔记技能） */
  skills: AISkill[];
  /** 已固定的技能 code 列表 */
  pinnedCodes: string[];
  /** 切换某技能的固定状态 */
  onToggle: (code: string) => void;
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 是否禁用（例如生成中） */
  disabled?: boolean;
}

const ChatSkillPicker: React.FC<ChatSkillPickerProps> = ({
  skills,
  pinnedCodes,
  onToggle,
  isDark = false,
  disabled = false,
}) => {
  const [open, setOpen] = useState(false);
  const [keyword, setKeyword] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭面板
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    if (!kw) return skills;
    return skills.filter(s =>
      s.name.toLowerCase().includes(kw)
      || (s.description ?? '').toLowerCase().includes(kw)
      || s.keywords?.some(k => k.toLowerCase().includes(kw)),
    );
  }, [skills, keyword]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        disabled={disabled}
        className={`flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs transition-colors disabled:opacity-50 ${
          pinnedCodes.length > 0
            ? isDark
              ? 'bg-orange-900/40 text-orange-300'
              : 'bg-orange-100 text-orange-700'
            : isDark
              ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
              : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
        }`}
        title="固定技能（发送时优先激活）"
      >
        <Sparkles size={14} />
        <span>技能</span>
        {pinnedCodes.length > 0 && (
          <span className="rounded-full bg-orange-600 px-1.5 text-[10px] text-white">
            {pinnedCodes.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute bottom-full left-0 z-50 mb-2 w-72 overflow-hidden rounded-lg border shadow-xl ${
            isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-white'
          }`}
        >
          <div className={`flex items-center gap-2 border-b px-2.5 py-2 ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
            <Search size={14} className={isDark ? 'text-gray-500' : 'text-gray-400'} />
            <input
              value={keyword}
              onChange={e => setKeyword(e.target.value)}
              placeholder="搜索技能…"
              className={`flex-1 bg-transparent text-xs outline-none ${
                isDark ? 'text-gray-200 placeholder-gray-500' : 'text-gray-700 placeholder-gray-400'
              }`}
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <p className={`px-3 py-3 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                未找到技能
              </p>
            ) : filtered.map(skill => {
              const pinned = pinnedCodes.includes(skill.code);
              return (
                <button
                  key={skill.id}
                  type="button"
                  onClick={() => onToggle(skill.code)}
                  className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${
                    isDark ? 'hover:bg-gray-700' : 'hover:bg-gray-50'
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border ${
                      pinned
                        ? 'border-orange-500 bg-orange-500 text-white'
                        : isDark ? 'border-gray-600' : 'border-gray-300'
                    }`}
                  >
                    {pinned && <Check size={11} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-xs font-medium ${isDark ? 'text-gray-100' : 'text-gray-800'}`}>
                      {skill.name}
                    </span>
                    {skill.description && (
                      <span className={`mt-0.5 block truncate text-[11px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                        {skill.description}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default ChatSkillPicker;