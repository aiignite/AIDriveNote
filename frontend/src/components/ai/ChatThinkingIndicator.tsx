/**
 * ChatThinkingIndicator — 模型思考过程展示（可折叠）
 *
 * 默认单行预览，点击展开/折叠；流式生成时展示跳动圆点。
 * 同时提供 extractThinkingContent 工具函数，用于从正文中剥离
 * ` thinking…` 段落（兼容把思考内联进 content 的模型）。
 */
import React, { useMemo, useState } from 'react';
import { Brain, ChevronDown, ChevronRight } from 'lucide-react';

/** 思考段落提取结果 */
export interface ThinkingExtractResult {
  /** 思考过程文本 */
  thinking: string;
  /** 去除思考段落后的正文 */
  answer: string;
}

/**
 * 从文本中提取 ` thinking…` 思考段落。
 *
 * 支持流式未闭合（有 ` thinking` 无 ``）场景；多个段落会合并。
 *
 * @param text 原始文本
 * @returns 思考文本与正文
 */
export function extractThinkingContent(text: string): ThinkingExtractResult {
  if (!text || (!text.includes(' thinking') && !text.includes('response>'))) {
    return { thinking: '', answer: text || '' };
  }
  let thinking = '';
  let rest = text;
  // 先处理闭合段落
  const closed = / thinking([\s\S]*?)<\/think>/gi;
  rest = rest.replace(closed, (_m, inner: string) => {
    thinking += (thinking ? '\n' : '') + inner.trim();
    return '';
  });
  // 再处理未闭合段落（流式中）
  const openIdx = rest.indexOf(' thinking');
  if (openIdx >= 0) {
    thinking += (thinking ? '\n' : '') + rest.slice(openIdx + 7).trim();
    rest = rest.slice(0, openIdx);
  }
  return { thinking: thinking.trim(), answer: rest.trim() };
}

interface ChatThinkingIndicatorProps {
  /** 思考过程文本 */
  thinking: string;
  /** 是否处于流式生成中（展示跳动圆点） */
  streaming?: boolean;
  /** 是否暗色主题 */
  isDark?: boolean;
  /** 额外样式 */
  className?: string;
}

const ChatThinkingIndicator: React.FC<ChatThinkingIndicatorProps> = ({
  thinking,
  streaming = false,
  isDark = false,
  className = '',
}) => {
  const [expanded, setExpanded] = useState(false);
  const preview = useMemo(() => {
    const flat = thinking.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
  }, [thinking]);

  if (!thinking.trim() && !streaming) return null;

  return (
    <div
      className={`mb-2 rounded-lg border text-xs ${
        isDark ? 'border-gray-700 bg-gray-800/60' : 'border-gray-200 bg-gray-50'
      } ${className}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(v => !v)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left"
      >
        {expanded
          ? <ChevronDown size={13} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
          : <ChevronRight size={13} className={isDark ? 'text-gray-400' : 'text-gray-500'} />}
        <Brain size={12} className={isDark ? 'text-gray-400' : 'text-gray-500'} />
        <span className={`font-medium ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          思考过程
        </span>
        {streaming && (
          <span className="flex items-center gap-0.5">
            <span className="h-1 w-1 animate-bounce rounded-full bg-orange-400" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-orange-400 [animation-delay:0.15s]" />
            <span className="h-1 w-1 animate-bounce rounded-full bg-orange-400 [animation-delay:0.3s]" />
          </span>
        )}
        {!expanded && preview && (
          <span className={`ml-1 truncate ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            {preview}
          </span>
        )}
      </button>
      {expanded && (
        <div
          className={`max-h-64 overflow-y-auto border-t px-2.5 py-2 leading-relaxed whitespace-pre-wrap ${
            isDark ? 'border-gray-700 text-gray-400' : 'border-gray-200 text-gray-500'
          }`}
        >
          {thinking.trim() || '正在思考…'}
        </div>
      )}
    </div>
  );
};

export default ChatThinkingIndicator;