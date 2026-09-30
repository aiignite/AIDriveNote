import React, { useEffect, useState } from 'react';
import { FileText, Loader2 } from 'lucide-react';
import { fetchWithAuth } from '../../services/client';

export interface MessageAttachmentItem {
  id?: string;
  name: string;
  mimeType?: string;
  previewUrl?: string;
}

interface MessageAttachmentGalleryProps {
  attachments?: MessageAttachmentItem[];
  variant?: 'default' | 'inverted';
  className?: string;
}

const AttachmentThumbnail: React.FC<{
  attachment: MessageAttachmentItem;
  variant: 'default' | 'inverted';
  onExpand: (url: string) => void;
}> = ({ attachment, variant, onExpand }) => {
  const [src, setSrc] = useState<string | undefined>(attachment.previewUrl);
  const [loading, setLoading] = useState(!attachment.previewUrl && Boolean(attachment.id));
  const [failed, setFailed] = useState(false);
  const isImage = attachment.mimeType?.startsWith('image/') || Boolean(attachment.previewUrl);

  useEffect(() => {
    if (attachment.previewUrl) {
      setSrc(attachment.previewUrl);
      setLoading(false);
      setFailed(false);
      return;
    }
    if (!attachment.id || !isImage) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let objectUrl: string | undefined;

    setLoading(true);
    setFailed(false);
    fetchWithAuth(`/ai/attachments/${attachment.id}`)
      .then(res => res.blob())
      .then((blob) => {
        if (cancelled) return;
        if (!blob.type.startsWith('image/')) {
          setFailed(true);
          setLoading(false);
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.id, attachment.previewUrl, isImage]);

  if (isImage && src && !failed) {
    return (
      <button
        type="button"
        onClick={() => onExpand(src)}
        className="group relative h-20 w-20 overflow-hidden rounded-lg border border-white/20 transition-transform hover:scale-[1.02]"
        title={attachment.name}
      >
        <img src={src} alt={attachment.name} className="h-full w-full object-cover" />
        <span className="absolute inset-0 bg-black/0 transition-colors group-hover:bg-black/10" />
      </button>
    );
  }

  if (isImage && loading) {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-lg border border-dashed border-gray-300 dark:border-gray-600">
        <Loader2 size={16} className="animate-spin text-gray-400" />
      </div>
    );
  }

  return (
    <div
      className={`inline-flex max-w-[180px] items-center gap-1 rounded-full border px-2 py-1 text-xs ${
        variant === 'inverted'
          ? 'border-white/25 bg-white/10 text-white'
          : 'border-gray-200 bg-gray-50 text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
      }`}
      title={attachment.name}
    >
      <FileText size={12} className="shrink-0" />
      <span className="truncate">{attachment.name}</span>
    </div>
  );
};

const MessageAttachmentGallery: React.FC<MessageAttachmentGalleryProps> = ({
  attachments = [],
  variant = 'default',
  className = '',
}) => {
  const [expandedUrl, setExpandedUrl] = useState<string | null>(null);

  if (attachments.length === 0) return null;

  return (
    <>
      <div className={`flex flex-wrap gap-2 ${className}`}>
        {attachments.map((attachment, index) => (
          <AttachmentThumbnail
            key={attachment.id || `${attachment.name}-${index}`}
            attachment={attachment}
            variant={variant}
            onExpand={setExpandedUrl}
          />
        ))}
      </div>

      {expandedUrl ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/80 p-6"
          onClick={() => setExpandedUrl(null)}
        >
          <img src={expandedUrl} alt="图片预览" className="max-h-full max-w-full object-contain" />
          <button
            type="button"
            className="absolute right-4 top-4 rounded-full p-2 text-white transition-colors hover:bg-white/20"
            onClick={() => setExpandedUrl(null)}
          >
            ✕
          </button>
        </div>
      ) : null}
    </>
  );
};

export default MessageAttachmentGallery;
