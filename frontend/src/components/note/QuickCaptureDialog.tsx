import React, { useEffect, useRef, useState } from 'react';
import { X, Zap } from 'lucide-react';

interface QuickCaptureDialogProps {
  open: boolean;
  isDark: boolean;
  onClose: () => void;
  onSave: (text: string) => void | Promise<void>;
}

/**
 * 快速捕获：一个输入框，第一行自动作为标题。
 * 目标是把「想到 → 记下」压缩到一次输入 + 一次回车。
 */
const QuickCaptureDialog: React.FC<QuickCaptureDialogProps> = ({
  open,
  isDark,
  onClose,
  onSave,
}) => {
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    setValue('');
    const timer = window.setTimeout(() => textareaRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    const text = value.trim();
    if (!text || saving) return;
    setSaving(true);
    try {
      await onSave(text);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-start justify-center pt-[18vh] bg-black/40" onClick={onClose}>
      <div
        className={`w-[560px] max-w-[92vw] rounded-2xl border shadow-2xl p-4 ${
          isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={event => event.stopPropagation()}
      >
        <div className={`mb-2 flex items-center justify-between gap-2 text-xs ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
          <span className="inline-flex items-center gap-1.5 font-medium">
            <Zap size={13} className="text-orange-500" /> 快速捕获
          </span>
          <button type="button" onClick={onClose} className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-700" aria-label="关闭">
            <X size={14} />
          </button>
        </div>
        <textarea
          ref={textareaRef}
          value={value}
          onChange={event => setValue(event.target.value)}
          onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
            }
          }}
          rows={4}
          placeholder="记点什么…（第一行会作为标题，⌘Enter 保存）"
          className={`w-full resize-none rounded-xl border px-3 py-2 text-sm outline-none ${
            isDark
              ? 'bg-gray-900 border-gray-700 text-gray-100 placeholder-gray-600 focus:border-orange-500'
              : 'bg-white border-gray-200 text-gray-900 placeholder-gray-400 focus:border-orange-400'
          }`}
        />
        <div className="mt-2 flex items-center justify-between">
          <span className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            会保存到 Inbox（根目录 / 当前文件夹）
          </span>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!value.trim() || saving}
            className="rounded-lg bg-orange-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-orange-700 disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default QuickCaptureDialog;
