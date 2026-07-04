/**
 * NoteChangeConfirmCard — AI 笔记内容变更预览，用户确认后再写入笔记。
 */
import React, { useState } from 'react';
import { Check, FileText, Loader2, X } from 'lucide-react';
import AIChatMarkdown from '../ai/AIChatMarkdown';

export interface NotePendingChange {
  noteId: string;
  noteTitle: string;
  noteType: string;
  changeType: 'update' | 'append';
  proposedContent: Record<string, unknown>;
  proposedTitle?: string | null;
  previewText: string;
  addedPreviewText?: string | null;
  currentPreviewText?: string | null;
  applied?: boolean;
  dismissed?: boolean;
}

interface NoteChangeConfirmCardProps {
  pending: NotePendingChange;
  applying?: boolean;
  onApply: () => void | Promise<void>;
  onDismiss: () => void;
}

const NoteChangeConfirmCard: React.FC<NoteChangeConfirmCardProps> = ({
  pending,
  applying = false,
  onApply,
  onDismiss,
}) => {
  const [expanded, setExpanded] = useState(true);

  if (pending.dismissed) return null;

  if (pending.applied) {
    return (
      <div className="mt-3 rounded-xl border border-emerald-200 dark:border-emerald-800 bg-emerald-50/80 dark:bg-emerald-950/20 p-3">
        <p className="text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-1.5">
          <Check size={14} />
          已应用到笔记「{pending.noteTitle}」
        </p>
      </div>
    );
  }

  const changeLabel = pending.changeType === 'append' ? '追加内容' : '更新内容';
  const previewBody = pending.changeType === 'append' && pending.addedPreviewText
    ? pending.addedPreviewText
    : pending.previewText;
  const showDiff = pending.changeType === 'update' && pending.currentPreviewText && previewBody;

  return (
    <div
      className="mt-3 rounded-xl border border-orange-200 dark:border-orange-800 bg-orange-50/60 dark:bg-orange-950/20 p-3"
      role="region"
      aria-label="笔记变更确认"
    >
      <div className="flex items-start gap-2">
        <FileText size={16} className="text-orange-600 dark:text-orange-400 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-orange-900 dark:text-orange-200">
            {changeLabel}预览 · {pending.noteTitle}
          </p>
          <p className="text-[11px] text-orange-800/80 dark:text-orange-300/80 mt-0.5">
            以下内容尚未写入笔记，请确认后再应用。
          </p>
          <button
            type="button"
            onClick={() => setExpanded(v => !v)}
            className="text-[10px] text-orange-600 dark:text-orange-400 mt-1 underline"
          >
            {expanded ? '收起预览' : '展开预览'}
          </button>
          {expanded && previewBody && (
            showDiff ? (
              <div className="mt-2 grid grid-cols-2 gap-2 max-h-64 overflow-y-auto">
                <div className="rounded-lg border border-gray-200 dark:border-gray-700 bg-white/80 dark:bg-gray-900/40 p-2">
                  <p className="text-[10px] font-semibold text-gray-500 mb-1">当前内容</p>
                  <div className="text-xs">
                    <AIChatMarkdown content={pending.currentPreviewText!} />
                  </div>
                </div>
                <div className="rounded-lg border border-orange-200 dark:border-orange-800 bg-white/80 dark:bg-gray-900/40 p-2">
                  <p className="text-[10px] font-semibold text-orange-600 mb-1">变更后</p>
                  <div className="text-xs">
                    <AIChatMarkdown content={previewBody} />
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-2 max-h-64 overflow-y-auto rounded-lg border border-orange-100 dark:border-orange-900/50 bg-white/80 dark:bg-gray-900/40 p-3 text-xs">
                <AIChatMarkdown content={previewBody} />
              </div>
            )
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          disabled={applying}
          className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex justify-end gap-2 mt-3">
        <button
          type="button"
          onClick={onDismiss}
          disabled={applying}
          className="px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-white/60 dark:hover:bg-gray-800"
        >
          取消
        </button>
        <button
          type="button"
          onClick={() => void onApply()}
          disabled={applying}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-600 hover:bg-orange-700 disabled:opacity-50 text-white text-xs font-semibold"
        >
          {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          应用到笔记
        </button>
      </div>
    </div>
  );
};

export default NoteChangeConfirmCard;
