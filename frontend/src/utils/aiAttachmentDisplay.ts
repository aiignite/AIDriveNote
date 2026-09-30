import type { MessageAttachmentItem } from '../components/ai/MessageAttachmentGallery';

export const stripAttachmentMarkers = (text: string): string => (
  text
    .replace(/\n?📎[^\n]*/g, '')
    .replace(/\n?\[已上传:[^\]]+\]/g, '')
    .replace(/\n?\[已上传文档附件:[\s\S]*?\]/g, '')
    .trim()
);

export const mapApiMessageAttachments = (raw: unknown): MessageAttachmentItem[] => {
  if (!Array.isArray(raw)) return [];
  const items: MessageAttachmentItem[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const name = typeof record.name === 'string' ? record.name : '';
    const id = typeof record.id === 'string' ? record.id : undefined;
    const mimeType = typeof record.mimeType === 'string'
      ? record.mimeType
      : typeof record.mime_type === 'string'
        ? record.mime_type
        : undefined;
    if (!name && !id) continue;
    items.push({
      id,
      name: name || '附件',
      mimeType,
    });
  }
  return items;
};
