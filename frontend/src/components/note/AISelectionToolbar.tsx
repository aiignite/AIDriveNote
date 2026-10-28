import React, { useEffect, useState } from 'react';
import {
  Sparkles, Languages, ListChecks, PenLine, MessageCircleQuestion,
} from 'lucide-react';

interface SelectionState {
  text: string;
  top: number;
  left: number;
}

interface AISelectionToolbarProps {
  /** 只在这个容器内的选区上浮出工具条（避免命中侧栏、聊天区） */
  containerRef: React.RefObject<HTMLElement | null>;
  isDark: boolean;
  /** selectionText 会随页面上下文一起送给模型；prompt 只是操作指令 */
  onAction: (selectionText: string, prompt: string) => void;
}

const ACTIONS = [
  {
    id: 'polish',
    label: '润色',
    icon: Sparkles,
    prompt: '请润色选中的文字，保持原意与语气，直接输出改写后的文本，不要解释。',
  },
  {
    id: 'translate',
    label: '翻译',
    icon: Languages,
    prompt: '请翻译选中的文字：中文译成英文，其他语言译成中文。只输出译文。',
  },
  {
    id: 'summarize',
    label: '总结',
    icon: ListChecks,
    prompt: '请用简洁的要点总结选中的文字。',
  },
  {
    id: 'continue',
    label: '续写',
    icon: PenLine,
    prompt: '请顺着选中的文字继续写下去，保持同样的语气与风格。',
  },
  {
    id: 'ask',
    label: '问 AI',
    icon: MessageCircleQuestion,
    prompt: '请解释选中的文字，并指出其中值得注意或需要进一步确认的点。',
  },
] as const;

const MAX_SELECTION_CHARS = 4000;

/**
 * 选区 AI 工具条：在编辑器内选中文字后浮出「润色 / 翻译 / 总结 / 续写 / 问 AI」。
 * 点击时不发送请求，而是把选区与指令交给 AI 侧栏（复用既有 presetMessage 管道）。
 */
const AISelectionToolbar: React.FC<AISelectionToolbarProps> = ({
  containerRef,
  isDark,
  onAction,
}) => {
  const [selection, setSelection] = useState<SelectionState | null>(null);

  useEffect(() => {
    const clear = () => setSelection(null);

    const update = () => {
      const active = window.getSelection();
      if (!active || active.isCollapsed || active.rangeCount === 0) {
        clear();
        return;
      }
      const text = active.toString().trim();
      if (!text || text.length > MAX_SELECTION_CHARS) {
        clear();
        return;
      }
      const container = containerRef.current;
      if (!container) return;
      const range = active.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        clear();
        return;
      }
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) {
        clear();
        return;
      }
      const halfWidth = 190;
      setSelection({
        text,
        top: Math.max(8, rect.top - 46),
        left: Math.min(
          Math.max(halfWidth, rect.left + rect.width / 2),
          Math.max(halfWidth, window.innerWidth - halfWidth),
        ),
      });
    };

    document.addEventListener('mouseup', update);
    document.addEventListener('keyup', update);
    document.addEventListener('mousedown', clear);
    document.addEventListener('scroll', clear, true);
    window.addEventListener('resize', clear);
    return () => {
      document.removeEventListener('mouseup', update);
      document.removeEventListener('keyup', update);
      document.removeEventListener('mousedown', clear);
      document.removeEventListener('scroll', clear, true);
      window.removeEventListener('resize', clear);
    };
  }, [containerRef]);

  if (!selection) return null;

  return (
    <div
      role="toolbar"
      aria-label="选区 AI 操作"
      className={`fixed z-[80] -translate-x-1/2 flex items-center gap-0.5 rounded-lg border px-1 py-1 shadow-xl ${
        isDark ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'
      }`}
      style={{ top: selection.top, left: selection.left }}
      // 阻止默认 mousedown：否则点击按钮前浏览器会先清掉选区
      onMouseDown={event => event.preventDefault()}
    >
      {ACTIONS.map(action => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            title={`对选中文字执行：${action.label}`}
            onClick={() => {
              const text = selection.text;
              setSelection(null);
              onAction(text, action.prompt);
            }}
            className={`inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] transition-colors ${
              isDark
                ? 'text-gray-200 hover:bg-gray-700'
                : 'text-gray-700 hover:bg-orange-50 hover:text-orange-700'
            }`}
          >
            <Icon size={12} />
            {action.label}
          </button>
        );
      })}
    </div>
  );
};

export default AISelectionToolbar;
