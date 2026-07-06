/**
 * 批量原格式导出 — 拉取全部笔记，写入本地文件夹或 ZIP 下载
 */
import { saveAs } from 'file-saver';
import JSZip from 'jszip';
import { noteApi, noteFolderApi, type Note } from '../services/note';
import { notesToNativeFiles, type NativeExportFile } from './noteNativeExport';

export class ExportCancelledError extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'AbortError';
  }
}

export interface BulkExportResult {
  method: 'folder' | 'zip';
  count: number;
  skippedEmpty: number;
}

function exportDirName(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `AIDriveNote-export-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function zipFileName(): string {
  return `${exportDirName()}.zip`;
}

async function fetchAllNotes(): Promise<Note[]> {
  const limit = 100;
  let skip = 0;
  let total = Infinity;
  const all: Note[] = [];

  while (skip < total) {
    const res = await noteApi.list({ skip, limit });
    all.push(...res.items);
    total = res.total;
    skip += limit;
  }

  return all;
}

function canUseDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && window.isSecureContext && getDirectoryPicker() !== null;
}

async function getOrCreateSubDir(
  root: FileSystemDirectoryHandle,
  relativeDir: string,
): Promise<FileSystemDirectoryHandle> {
  if (!relativeDir) return root;
  const parts = relativeDir.split('/').filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = await current.getDirectoryHandle(part, { create: true });
  }
  return current;
}

async function writeFileToDirectory(
  rootDir: FileSystemDirectoryHandle,
  file: NativeExportFile,
): Promise<void> {
  const normalized = file.relativePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const dirPath = lastSlash >= 0 ? normalized.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized;

  const targetDir = await getOrCreateSubDir(rootDir, dirPath);
  const handle = await targetDir.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  await writable.write(file.blob);
  await writable.close();
}

function getDirectoryPicker(): ((options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>) | null {
  const w = window as unknown as {
    showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  };
  return w.showDirectoryPicker ?? null;
}

async function writeToDirectoryPicker(
  files: NativeExportFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const picker = getDirectoryPicker();
  if (!picker) throw new Error('Directory picker unavailable');
  const parentDir = await picker({ mode: 'readwrite' });
  const exportDir = await parentDir.getDirectoryHandle(exportDirName(), { create: true });

  for (let i = 0; i < files.length; i += 1) {
    await writeFileToDirectory(exportDir, files[i]);
    onProgress?.(i + 1, files.length);
  }
}

async function writeToZip(
  files: NativeExportFile[],
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  const zip = new JSZip();
  const rootFolder = exportDirName();

  for (let i = 0; i < files.length; i += 1) {
    const f = files[i];
    zip.file(`${rootFolder}/${f.relativePath}`, f.blob);
    onProgress?.(i + 1, files.length);
  }

  const blob = await zip.generateAsync({ type: 'blob' });
  saveAs(blob, zipFileName());
}

export async function exportAllNotesNative(
  onProgress?: (done: number, total: number) => void,
): Promise<BulkExportResult> {
  onProgress?.(0, 0);

  const [notes, folders] = await Promise.all([
    fetchAllNotes(),
    noteFolderApi.list(),
  ]);

  if (notes.length === 0) {
    return { method: 'zip', count: 0, skippedEmpty: 0 };
  }

  const { files, skippedEmpty } = notesToNativeFiles(notes, folders);

  if (files.length === 0) {
    return { method: 'zip', count: 0, skippedEmpty };
  }

  if (canUseDirectoryPicker()) {
    try {
      await writeToDirectoryPicker(files, onProgress);
      return { method: 'folder', count: files.length, skippedEmpty };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new ExportCancelledError();
      }
      // 写入失败时回退 ZIP
    }
  }

  await writeToZip(files, onProgress);
  return { method: 'zip', count: files.length, skippedEmpty };
}
