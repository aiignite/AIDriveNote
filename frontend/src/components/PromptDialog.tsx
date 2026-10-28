import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';

interface PromptDialogProps {
  isOpen: boolean;
  title: string;
  label?: string;
  value: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  onChange: (value: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
}

/** 应用内单行输入对话框，替代原生 prompt()（原生弹窗样式不可控且会被部分浏览器拦截）。 */
const PromptDialog: React.FC<PromptDialogProps> = ({
  isOpen,
  title,
  label,
  value,
  placeholder,
  confirmLabel = '确定',
  cancelLabel = '取消',
  onChange,
  onConfirm,
  onCancel,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const timer = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="fixed inset-0 bg-black/50 backdrop-blur-sm" onClick={onCancel} />
      <div className="relative bg-white dark:bg-gray-800 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 w-full max-w-md mx-4 p-6">
        <button
          type="button"
          onClick={onCancel}
          className="absolute top-4 right-4 p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700"
          aria-label="关闭"
        >
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
        {label && (
          <label className="block mt-4 text-xs text-gray-600 dark:text-gray-400">{label}</label>
        )}
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          onChange={event => onChange(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault();
              onConfirm();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              onCancel();
            }
          }}
          className="mt-1.5 w-full rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:border-orange-400"
        />
        <div className="flex justify-end gap-3 mt-6">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-xl hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={!value.trim()}
            className="px-4 py-2 text-sm font-medium text-white rounded-xl bg-orange-600 hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PromptDialog;
