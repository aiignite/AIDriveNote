import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Loader2, X } from 'lucide-react';

export interface AttachmentPreviewItem {
  key: string;
  name: string;
  mimeType?: string;
  previewUrl?: string;
  uploading?: boolean;
  error?: string;
}

interface PendingAttachmentPreviewProps {
  items: AttachmentPreviewItem[];
  onRemove: (key: string) => void;
  className?: string;
}

const PendingAttachmentPreview: React.FC<PendingAttachmentPreviewProps> = ({
  items,
  onRemove,
  className = '',
}) => {
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);

  if (items.length === 0) return null;

  return (
    <>
      <div className={`flex flex-wrap gap-2 ${className}`}>
        {items.map((item) => {
          const isImage = Boolean(item.previewUrl || item.mimeType?.startsWith('image/'));

          if (isImage && item.previewUrl) {
            return (
              <div key={item.key} className="group relative">
                <button
                  type="button"
                  onClick={() => setExpandedUrl(item.previewUrl!)}
                  className={`relative h-20 w-20 overflow-hidden rounded-lg border transition-transform hover:scale-[1.02] ${
                    item.error
                      ? 'border-amber-300 dark:border-amber-600'
                      : 'border-gray-200 dark:border-gray-700'
                  }`}
                  title={item.error ? '预上传未完成，发送时会自动上传' : item.name}
                >
                  <img
                    src={item.previewUrl}
                    alt={item.name}
                    className="h-full w-full object-cover"
                  />
                  <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
                </button>

                {item.uploading ? (
                  <span className="pointer-events-none absolute left-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/60">
                    <Loader2 size={12} className="animate-spin text-white" />
                  </span>
                ) : null}

                {item.error ? (
                  <span
                    className="pointer-events-none absolute left-1 top-1 rounded bg-amber-500/95 px-1 py-0.5 text-[9px] font-medium leading-none text-white shadow-sm"
                    title="预上传未完成，发送时会自动上传"
                  >
                    待发
                  </span>
                ) : null}

                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemove(item.key);
                  }}
                  className="absolute -right-1 -top-1 z-10 flex h-5 w-5 items-center justify-center rounded-full bg-gray-800/85 text-white opacity-100 shadow-sm transition-opacity hover:bg-red-600 sm:opacity-0 sm:group-hover:opacity-100"
                  title="移除"
                >
                  <X size={12} />
                </button>
              </div>
            );
          }

          return (
            <div
              key={item.key}
              className={`inline-flex max-w-[180px] items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${
                item.error
                  ? 'border-red-200 bg-red-50 text-red-600 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400'
                  : item.uploading
                    ? 'border-gray-200 bg-gray-50 text-gray-500 dark:border-gray-600 dark:bg-gray-800/50 dark:text-gray-400'
                    : 'border-orange-200 bg-orange-50 text-orange-700 dark:border-orange-700 dark:bg-orange-900/30 dark:text-orange-300'
              }`}
              title={item.error || (item.uploading ? '正在上传…' : item.name)}
            >
              {item.uploading ? (
                <Loader2 size={12} className="animate-spin shrink-0" />
              ) : item.error ? (
                <span className="shrink-0 leading-none">!</span>
              ) : (
                <FileText size={12} className="shrink-0" />
              )}
              <span className="truncate">{item.name}</span>
              <button
                type="button"
                onClick={() => onRemove(item.key)}
                className="shrink-0 transition-colors hover:text-red-500"
                title="移除"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      {expandedUrl && typeof document !== 'undefined' ? createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setExpandedUrl(null)}
        >
          <img src={expandedUrl} alt="附件预览" className="max-h-full max-w-full object-contain" />
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full p-2 text-white transition-colors hover:bg-white/20"
            onClick={() => setExpandedUrl(null)}
          >
            <X size={20} />
          </button>
        </div>,
        document.body,
      ) : null}
    </>
  );
};

export default PendingAttachmentPreview;
