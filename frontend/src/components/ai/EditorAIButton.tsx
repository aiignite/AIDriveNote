/** 编辑器内 AI 入口 — 选区润色/续写或打开侧栏 */
import React, { useCallback, useState } from 'react';
import { Bot, ChevronDown } from 'lucide-react';
import { useApp } from '../../contexts/AppContext';
import { buildInlineAIPrompt } from '../../utils/noteAIActions';

interface EditorAIButtonProps {
  noteType: string;
  title: string;
  isDark?: boolean;
  /** 无选区时的默认提示 */
  fallbackPrompt?: string;
}

const EditorAIButton: React.FC<EditorAIButtonProps> = ({
  noteType,
  title,
  isDark = false,
  fallbackPrompt,
}) => {
  const { openAI } = useApp();
  const [open, setOpen] = useState(false);

  const getSelection = () => window.getSelection()?.toString().trim() || '';

  const launch = useCallback((action?: 'polish' | 'translate' | 'continue' | 'summarize') => {
    const selection = getSelection();
    let presetMessage: string;
    if (selection && action && (noteType === 'markdown' || noteType === 'rich_text')) {
      presetMessage = buildInlineAIPrompt(action, selection, title);
    } else if (fallbackPrompt) {
      presetMessage = fallbackPrompt;
    } else if (noteType === 'mindmap') {
      presetMessage = `请扩展思维导图「${title}」的当前选中节点`;
    } else if (noteType === 'flowchart') {
      presetMessage = `请补充流程图「${title}」的步骤或分支`;
    } else {
      presetMessage = `请优化当前笔记「${title}」`;
    }
    openAI({ presetMessage, selectionText: selection || undefined });
    setOpen(false);
  }, [noteType, title, fallbackPrompt, openAI]);

  const hasInline = noteType === 'markdown' || noteType === 'rich_text';

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => hasInline ? setOpen(v => !v) : launch()}
        className={`inline-flex items-center gap-1 p-1.5 rounded-lg text-xs ${isDark ? 'text-orange-400 hover:bg-gray-700' : 'text-orange-600 hover:bg-orange-50'}`}
        title="AI 助手"
      >
        <Bot size={14} />
        {hasInline && <ChevronDown size={12} />}
      </button>
      {open && hasInline && (
        <div className={`absolute right-0 top-full mt-1 z-50 min-w-[120px] rounded-lg border shadow-lg py-1 text-xs ${isDark ? 'bg-gray-800 border-gray-600' : 'bg-white border-gray-200'}`}>
          {(['polish', 'continue', 'translate', 'summarize'] as const).map(action => (
            <button
              key={action}
              type="button"
              onClick={() => launch(action)}
              className={`block w-full text-left px-3 py-1.5 ${isDark ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-50 text-gray-700'}`}
            >
              {{ polish: '润色选区', continue: '续写选区', translate: '翻译选区', summarize: '总结选区' }[action]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default EditorAIButton;
