import { api, buildQuery, fetchWithAuth } from './client';

export interface KbRootInfo {
  id: string;
  name: string;
  folderId?: string | null;
  createdAt?: string | null;
}

export interface KbFileInfo {
  id: string;
  rootId: string;
  path: string;
  mime?: string | null;
  size: number;
  status: string;
  isProtected: boolean;
  noteId?: string | null;
  hasText: boolean;
  viewable?: boolean;
  updatedAt?: string | null;
}

export interface KbManifestResult {
  toUpload: string[];
  unchanged: number;
  missing: string[];
  total: number;
}

export const kbApi = {
  listRoots: () => api.get<KbRootInfo[]>('/kb/roots'),
  ensureRoot: (name: string, folderId?: string) =>
    api.post<KbRootInfo>('/kb/roots', { name, folderId }),
  listFiles: (query?: string, limit = 50) =>
    api.get<KbFileInfo[]>(`/kb/files${buildQuery({ query, limit })}`),
  manifest: (
    rootId: string,
    files: Array<{ path: string; hash: string; size?: number; mime?: string }>,
  ) => api.post<KbManifestResult>(`/kb/roots/${rootId}/manifest`, { files }),
  convert: (fileId: string) =>
    api.post<{ noteId: string; title: string; noteType?: string }>(
      `/kb/files/${fileId}/to-note`,
      {},
    ),
  downloadFile: async (fileId: string, fileName: string): Promise<void> => {
    const response = await fetchWithAuth(`/kb/files/${fileId}/content`);
    if (!response.ok) throw new Error('原文件下载失败');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
  uploadFile: async (
    rootId: string,
    path: string,
    file: File,
    isProtected = false,
  ): Promise<KbFileInfo> => {
    const form = new FormData();
    form.append('file', file, file.name);
    const response = await fetchWithAuth(
      `/kb/roots/${rootId}/files${buildQuery({ path, is_protected: isProtected })}`,
      { method: 'POST', body: form },
    );
    if (!response.ok) {
      let message = '上传失败';
      try {
        const payload = await response.json() as { detail?: string };
        if (payload?.detail) message = payload.detail;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }
    return await response.json() as KbFileInfo;
  },
};
