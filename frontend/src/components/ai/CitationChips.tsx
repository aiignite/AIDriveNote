import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Link2 } from 'lucide-react';
import type { CitationItem } from '../../services/ai/ai';

interface CitationChipsProps {
  citations?: CitationItem[];
  isDark: boolean;
}

/**
 * AI 回答的引用来源芯片。点击直接跳到对应笔记（P0 为笔记级定位），
 * hover 展示命中片段，让用户能验证回答是否有依据。
 */
const CitationChips: React.FC<CitationChipsProps> = ({ citations, isDark }) => {
  const navigate = useNavigate();
  if (!citations || citations.length === 0) return null;

  return (
    <div className={`mt-3 border-t pt-2 ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
      <p className={`text-[11px] mb-1.5 ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
        依据 {citations.length} 篇笔记
      </p>
      <div className="flex flex-wrap gap-1.5">
        {citations.map((citation, index) => (
          <button
            key={`${citation.noteId}-${index}`}
            type="button"
            title={citation.quote || citation.title}
            onClick={() => navigate(
              `/note/${citation.noteId}${citation.chunkId ? `?chunk=${citation.chunkId}` : ''}`,
            )}
            className={`inline-flex items-center gap-1 max-w-full rounded-full px-2 py-1 text-[11px] transition-colors ${
              isDark
                ? 'bg-gray-700/70 text-gray-200 hover:bg-gray-600'
                : 'bg-white text-gray-700 border border-gray-200 hover:border-orange-300 hover:text-orange-700'
            }`}
          >
            <Link2 size={11} className="shrink-0" />
            <span className="truncate max-w-[180px]">{citation.title}</span>
          </button>
        ))}
      </div>
    </div>
  );
};

export default CitationChips;
