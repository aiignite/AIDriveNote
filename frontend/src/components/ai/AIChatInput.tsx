import React, { useCallback, useEffect, useRef } from 'react';
import { Image, Paperclip, Send } from 'lucide-react';
import PendingAttachmentPreview, { type AttachmentPreviewItem } from './PendingAttachmentPreview';

export interface PendingAttachment {
  localId: string;
  file: File;
  uploading: boolean;
  error?: string;
  serverId?: string;
  previewUrl?: string;
}

interface AIChatInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop?: () => void;
  loading?: boolean;
  pendingFiles: PendingAttachment[];
  onSelectFiles: (files: File[]) => void;
  onRemoveFile: (localId: string) => void;
  isDark?: boolean;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
}

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

export function createPendingAttachment(file: File): PendingAttachment {
  return {
    localId: generateId(),
    file,
    uploading: true,
    previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
  };
}

const AIChatInput: React.FC<AIChatInputProps> = ({
  value,
  onChange,
  onSend,
  onStop,
  loading = false,
  pendingFiles,
  onSelectFiles,
  onRemoveFile,
  isDark = false,
  inputRef,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const mergedRef = inputRef ?? textareaRef;

  useEffect(() => {
    const el = mergedRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value, mergedRef]);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;
      const file = item.getAsFile();
      if (!file) continue;

      e.preventDefault();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const extension = file.type === 'image/png'
        ? 'png'
        : file.type === 'image/jpeg'
          ? 'jpg'
          : file.type.split('/')[1] || 'png';
      const fileName = file.name || `screenshot-${timestamp}.${extension}`;
      imageFiles.push(new File([file], fileName, { type: file.type }));
    }

    if (imageFiles.length > 0) {
      onSelectFiles(imageFiles);
    }
  }, [onSelectFiles]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSend();
    }
  }, [onSend]);

  const previewItems: AttachmentPreviewItem[] = pendingFiles.map(pf => ({
    key: pf.localId,
    name: pf.file.name,
    mimeType: pf.file.type,
    previewUrl: pf.previewUrl,
    uploading: pf.uploading,
    error: pf.error,
  }));

  const canSend = (value.trim() || pendingFiles.length > 0) && !loading;

  return (
    <div className={`p-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
      <div className="mb-2 flex items-center gap-1">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.txt,.md,.doc,.docx,.csv,.json"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) onSelectFiles(Array.from(files));
            e.target.value = '';
          }}
        />
        <input
          ref={imageInputRef}
          type="file"
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const files = e.target.files;
            if (files?.length) onSelectFiles(Array.from(files));
            e.target.value = '';
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={loading}
          className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
            isDark ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
          }`}
          title="上传附件"
        >
          <Paperclip size={16} />
        </button>
        <button
          type="button"
          onClick={() => imageInputRef.current?.click()}
          disabled={loading}
          className={`p-1.5 rounded-lg transition-colors disabled:opacity-50 ${
            isDark ? 'text-gray-400 hover:bg-gray-800 hover:text-gray-200' : 'text-gray-400 hover:bg-gray-100 hover:text-gray-600'
          }`}
          title="添加图片"
        >
          <Image size={16} />
        </button>
      </div>

      <PendingAttachmentPreview
        className="mb-2"
        items={previewItems}
        onRemove={onRemoveFile}
      />

      <div className="flex items-end gap-2">
        <textarea
          ref={mergedRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="输入消息… (Enter 发送，Shift+Enter 换行，可直接粘贴图片)"
          rows={2}
          disabled={loading}
          className={`flex-1 resize-none rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500 ${
            isDark ? 'bg-gray-800 border-gray-600 text-white placeholder-gray-500' : 'bg-white border-gray-300'
          }`}
          style={{ minHeight: '44px', maxHeight: '160px' }}
        />
        <button
          type="button"
          onClick={loading ? onStop : onSend}
          disabled={loading ? !onStop : !canSend}
          className={`shrink-0 rounded-lg p-2 disabled:opacity-50 ${
            loading
              ? isDark
                ? 'bg-gray-700 text-white hover:bg-gray-600'
                : 'bg-gray-200 text-gray-900 hover:bg-gray-300'
              : 'bg-orange-600 text-white'
          }`}
          title={loading ? '停止生成' : '发送'}
          aria-label={loading ? '停止生成' : '发送'}
        >
          {loading ? (
            <span className="block h-[18px] w-[18px] rounded-[2px] bg-black" aria-hidden />
          ) : (
            <Send size={18} />
          )}
        </button>
      </div>
    </div>
  );
};

export default AIChatInput;
