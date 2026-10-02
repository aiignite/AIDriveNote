/**
 * SkillActivationCard — 展示一轮对话中已激活的技能
 *
 * 头部展示“已激活 N 个技能”与前 3 个技能标签，展开后逐条展示技能名称、描述、
 * 匹配得分与结构化命中原因（reasons）。
 */
import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Sparkles } from 'lucide-react';
import type { ActivatedSkillInfo } from '../../services/ai/ai';

interface SkillActivationCardProps {
  /** 本轮激活的技能列表 */
  skills: ActivatedSkillInfo[];
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 额外样式 */
  className?: string;
}

/** 将后端下发的英文原因兜底映射为中文（正常已是中文） */
const reasonLabel = (reason: string): string => {
  const map: Record<string, string> = {
    skill_bound: '助手绑定',
    page_default: '页面默认',
    keyword: '关键词命中',
    note_type: '类型匹配',
    manual: '手动固定',
  };
  return map[reason] ?? reason;
};

const SkillActivationCard: React.FC<SkillActivationCardProps> = ({
  skills,
  isDark = false,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(false);
  if (!skills || skills.length === 0) return null;

  const headChips = skills.slice(0, 3);
  const restCount = skills.length - headChips.length;

  return (
    <div
      className={`mb-2 rounded-lg border text-xs ${
        isDark
          ? 'border-orange-900/50 bg-orange-950/20'
          : 'border-orange-100 bg-orange-50/70'
      } ${className}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {expanded
          ? <ChevronDown size={13} className={isDark ? 'text-orange-300' : 'text-orange-600'} />
          : <ChevronRight size={13} className={isDark ? 'text-orange-300' : 'text-orange-600'} />}
        <Sparkles size={12} className={isDark ? 'text-orange-300' : 'text-orange-600'} />
        <span className={`font-medium ${isDark ? 'text-orange-200' : 'text-orange-700'}`}>
          已激活 {skills.length} 个技能
        </span>
        <span className="flex flex-wrap items-center gap-1">
          {headChips.map(s => (
            <span
              key={s.code ?? s.name}
              className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                isDark ? 'bg-orange-900/50 text-orange-200' : 'bg-white text-orange-700'
              }`}
            >
              {s.name}
            </span>
          ))}
          {restCount > 0 && (
            <span className={`text-[10px] ${isDark ? 'text-orange-400/70' : 'text-orange-500/80'}`}>
              +{restCount}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className={`space-y-2 border-t px-2.5 py-2 ${isDark ? 'border-orange-900/40' : 'border-orange-100'}`}>
          {skills.map(s => (
            <div key={s.code ?? s.name}>
              <div className="flex items-center gap-1.5">
                <span className={`font-medium ${isDark ? 'text-orange-200' : 'text-orange-700'}`}>
                  {s.name}
                </span>
                {typeof s.score === 'number' && (
                  <span className={`text-[10px] ${isDark ? 'text-orange-400/60' : 'text-orange-500/70'}`}>
                    得分 {s.score}
                  </span>
                )}
              </div>
              {s.description && (
                <p className={`mt-0.5 leading-relaxed ${isDark ? 'text-orange-300/70' : 'text-orange-600/80'}`}>
                  {s.description}
                </p>
              )}
              {s.reasons && s.reasons.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {s.reasons.map(r => (
                    <span
                      key={r}
                      className={`rounded px-1.5 py-0.5 text-[10px] ${
                        isDark ? 'bg-orange-900/40 text-orange-300' : 'bg-white text-orange-600'
                      }`}
                    >
                      {reasonLabel(r)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default SkillActivationCard;