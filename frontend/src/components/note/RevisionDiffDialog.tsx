import React from 'react';
import { X } from 'lucide-react';
import type { DiffLine } from '../../utils/noteDiff';

interface RevisionDiffDialogProps {
  open: boolean;
  isDark: boolean;
  title: string;
  lines: DiffLine[];
  onClose: () => void;
}

const RevisionDiffDialog: React.FC<RevisionDiffDialogProps> = ({
  open,
  isDark,
  title,
  lines,
  onClose,
}) => {
  if (!open) return null;
  const added = lines.filter(line => line.kind === 'add').length;
  const removed = lines.filter(line => line.kind === 'del').length;

  return (
    <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className={`flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border shadow-2xl ${
          isDark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'
        }`}
        onClick={event => event.stopPropagation()}
      >
        <div className={`flex items-center justify-between border-b px-4 py-2 text-xs ${isDark ? 'border-gray-700 text-gray-300' : 'border-gray-100 text-gray-600'}`}>
          <span className="font-medium">版本对比 · {title}</span>
          <div className="flex items-center gap-2">
            <span className="text-green-600">+{added}</span>
            <span className="text-red-500">-{removed}</span>
            <button type="button" onClick={onClose} className="rounded p-1 hover:bg-gray-100 dark:hover:bg-gray-800" aria-label="关闭">
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 font-mono text-[11px] leading-5">
          {lines.map((line, index) => (
            <div
              key={index}
              className={`whitespace-pre-wrap break-words ${
                line.kind === 'add'
                  ? 'bg-green-50 text-green-800 dark:bg-green-950/30 dark:text-green-300'
                  : line.kind === 'del'
                    ? 'bg-red-50 text-red-700 line-through decoration-red-300 dark:bg-red-950/30 dark:text-red-300'
                    : isDark ? 'text-gray-400' : 'text-gray-600'
              }`}
            >
              <span className="mr-2 inline-block w-8 select-none text-right opacity-50">
                {line.kind === 'del' ? line.oldLine : line.newLine ?? ''}
              </span>
              {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
              {line.text || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default RevisionDiffDialog;
