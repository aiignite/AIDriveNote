/**
 * 笔记原格式导出 — 按 note_type 转为原生文件（.md / .json / .drawio）
 */
import type { Note, NoteFolder } from '../services/note';

export interface NativeExportFile {
  relativePath: string;
  blob: Blob;
}

export function sanitizeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 60);
}

export function getNativeExtension(noteType: string): string {
  switch (noteType) {
    case 'markdown':
      return '.md';
    case 'rich_text':
    case 'mindmap':
      return '.json';
    case 'flowchart':
      return '.drawio';
    default:
      return '.json';
  }
}

export function buildFolderPath(
  folderId: string | undefined,
  folders: NoteFolder[],
): string {
  if (!folderId) return '';
  const map = new Map(folders.map(f => [f.id, f]));
  const parts: string[] = [];
  let cur = map.get(folderId);
  while (cur) {
    parts.unshift(sanitizeFileName(cur.name));
    cur = cur.parentId ? map.get(cur.parentId) : undefined;
  }
  return parts.join('/');
}

function isEmptyContent(noteType: string, content: Record<string, unknown> | undefined): boolean {
  if (!content || typeof content !== 'object') return true;
  switch (noteType) {
    case 'markdown':
      return typeof content.text !== 'string' || content.text.trim() === '';
    case 'flowchart':
      return typeof content.xml !== 'string' || content.xml.trim() === '';
    case 'rich_text':
      return !Array.isArray(content.blocks) || content.blocks.length === 0;
    case 'mindmap':
      return !content.data && (!content.children || (content.children as unknown[]).length === 0);
    default:
      return Object.keys(content).length === 0;
  }
}

function noteToNativeBlob(note: Note): Blob | null {
  const content = note.content;
  if (!content || isEmptyContent(note.noteType, content)) return null;

  switch (note.noteType) {
    case 'markdown': {
      const text = typeof content.text === 'string' ? content.text : '';
      return new Blob([text], { type: 'text/markdown;charset=utf-8' });
    }
    case 'flowchart': {
      const xml = typeof content.xml === 'string' ? content.xml : '';
      return new Blob([xml], { type: 'application/xml;charset=utf-8' });
    }
    case 'rich_text':
    case 'mindmap':
    default: {
      const json = JSON.stringify(content, null, 2);
      return new Blob([json], { type: 'application/json;charset=utf-8' });
    }
  }
}

function buildBaseFileName(note: Note): string {
  return sanitizeFileName(note.title || '无标题');
}

/**
 * 将笔记列表转为待写入的原格式文件，处理重名冲突。
 */
export function notesToNativeFiles(
  notes: Note[],
  folders: NoteFolder[],
): { files: NativeExportFile[]; skippedEmpty: number } {
  const usedPaths = new Set<string>();
  const files: NativeExportFile[] = [];
  let skippedEmpty = 0;

  for (const note of notes) {
    const blob = noteToNativeBlob(note);
    if (!blob) {
      skippedEmpty += 1;
      continue;
    }

    const folderPath = buildFolderPath(note.folderId, folders);
    const ext = getNativeExtension(note.noteType);
    let baseName = buildBaseFileName(note);
    let relativePath = folderPath
      ? `${folderPath}/${baseName}${ext}`
      : `${baseName}${ext}`;

    if (usedPaths.has(relativePath)) {
      baseName = `${baseName}__${note.noteNo}`;
      relativePath = folderPath
        ? `${folderPath}/${baseName}${ext}`
        : `${baseName}${ext}`;
    }
    usedPaths.add(relativePath);
    files.push({ relativePath, blob });
  }

  return { files, skippedEmpty };
}
