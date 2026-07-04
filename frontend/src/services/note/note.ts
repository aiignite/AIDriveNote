import { api, buildQuery } from '../client';

// ── 类型定义 ──────────────────────────────────────────────

export interface NoteTag {
  id: string;
  name: string;
  color: string;
}

export interface Note {
  id: string;
  noteNo: string;
  title: string;
  noteType: 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';
  content?: Record<string, unknown>;
  folderId?: string;
  description?: string;
  status: string;
  isPinned: boolean;
  isDeleted: boolean;
  deletedAt?: string;
  previewText?: string;
  isFavorite?: boolean;
  tags?: NoteTag[];
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NoteCreate {
  title: string;
  noteType: 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';
  content?: Record<string, unknown>;
  folderId?: string;
  description?: string;
  status?: string;
}

export interface NoteUpdate {
  title?: string;
  noteType?: 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';
  content?: Record<string, unknown>;
  folderId?: string;
  description?: string;
  status?: string;
  isPinned?: boolean;
}

export interface NoteFolder {
  id: string;
  name: string;
  parentId?: string;
  userId: string;
  sortOrder: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface FolderCreate {
  name: string;
  parentId?: string;
}

export interface FolderUpdate {
  name?: string;
  parentId?: string;
  sortOrder?: number;
}

export interface NoteListResponse {
  items: Note[];
  total: number;
}

export interface NoteListParams {
  skip?: number;
  limit?: number;
  search?: string;
  noteType?: string;
  folderId?: string;
  status?: string;
  isPinned?: boolean;
  isFavorite?: boolean;
  tagIds?: string[];
  includeShared?: boolean;
}

export interface NoteRevision {
  id: string;
  noteId: string;
  title: string;
  contentSnapshot?: Record<string, unknown>;
  description?: string;
  changeSummary?: string;
  changedBy?: string;
  createdAt?: string;
}

export interface NoteBacklink {
  linkId: string;
  sourceId: string;
  sourceTitle: string;
  sourceNoteNo: string;
  linkText: string;
}

export interface NoteShare {
  id: string;
  noteId: string;
  sharedWithUserId: string;
  permission: 'view' | 'edit';
  createdBy?: string;
  createdAt?: string;
}

export interface NoteSearchResponse {
  items: Note[];
  total: number;
  highlights: Record<string, string>;
}

// ── API ──────────────────────────────────────────────

export const noteApi = {
  list: (params?: NoteListParams) =>
    api.get<NoteListResponse>(`/notes${buildQuery(params ? {
      skip: params.skip,
      limit: params.limit,
      search: params.search,
      note_type: params.noteType,
      folder_id: params.folderId,
      status: params.status,
      is_pinned: params.isPinned,
      is_favorite: params.isFavorite,
      tag_ids: params.tagIds?.join(','),
      include_shared: params.includeShared,
    } : undefined)}`),

  listTrash: (params?: { skip?: number; limit?: number; search?: string }) =>
    api.get<NoteListResponse>(`/notes/trash/list${buildQuery(params)}`),

  search: (q: string, params?: { skip?: number; limit?: number }) =>
    api.get<NoteSearchResponse>(`/notes/search/fulltext${buildQuery({ q, ...params })}`),

  get: (id: string) => api.get<Note>(`/notes/${id}`),

  create: (data: NoteCreate) => api.post<Note>('/notes', data),

  update: (id: string, data: NoteUpdate) => api.patch<Note>(`/notes/${id}`, data),

  delete: (id: string) => api.delete(`/notes/${id}`),

  restore: (id: string) => api.post<Note>(`/notes/${id}/restore`, {}),

  permanentDelete: (id: string) => api.delete(`/notes/${id}/permanent`),

  duplicate: (id: string) => api.post<Note>(`/notes/${id}/duplicate`, {}),

  addFavorite: (id: string) => api.post(`/notes/${id}/favorite`, {}),

  removeFavorite: (id: string) => api.delete(`/notes/${id}/favorite`),

  getBacklinks: (id: string) => api.get<NoteBacklink[]>(`/notes/${id}/backlinks`),

  listRevisions: (id: string) => api.get<NoteRevision[]>(`/notes/${id}/revisions`),

  restoreRevision: (noteId: string, revisionId: string) =>
    api.post<Note>(`/notes/${noteId}/revisions/${revisionId}/restore`, {}),

  listShares: (id: string) => api.get<NoteShare[]>(`/notes/${id}/shares`),

  addShare: (id: string, data: { sharedWithUserId: string; permission: 'view' | 'edit' }) =>
    api.post<NoteShare>(`/notes/${id}/shares`, {
      shared_with_user_id: data.sharedWithUserId,
      permission: data.permission,
    }),

  removeShare: (noteId: string, userId: string) =>
    api.delete(`/notes/${noteId}/shares/${userId}`),
};

// ── Tag API ──────────────────────────────────────────

export const noteTagApi = {
  list: () => api.get<NoteTag[]>('/notes/tags/list'),

  create: (data: { name: string; color?: string }) =>
    api.post<NoteTag>('/notes/tags', data),

  update: (id: string, data: { name?: string; color?: string }) =>
    api.patch<NoteTag>(`/notes/tags/${id}`, data),

  delete: (id: string) => api.delete(`/notes/tags/${id}`),

  addToNote: (noteId: string, tagId: string) =>
    api.post(`/notes/${noteId}/tags/${tagId}`, {}),

  removeFromNote: (noteId: string, tagId: string) =>
    api.delete(`/notes/${noteId}/tags/${tagId}`),
};

// ── Folder API ──────────────────────────────────────

export const noteFolderApi = {
  list: () => api.get<NoteFolder[]>('/notes/folders/list'),

  create: (data: FolderCreate) => api.post<NoteFolder>('/notes/folders', data),

  update: (id: string, data: FolderUpdate) =>
    api.patch<NoteFolder>(`/notes/folders/${id}`, data),

  delete: (id: string) => api.delete(`/notes/folders/${id}`),
};

// ── Template Types ──────────────────────────────────

export interface NoteTemplate {
  id: string;
  name: string;
  noteType: 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';
  description?: string;
  content?: Record<string, unknown>;
  thumbnail?: string;
  isBuiltin: boolean;
  sortOrder: number;
  userId?: string;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface TemplateCreate {
  name: string;
  noteType: 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';
  description?: string;
  content?: Record<string, unknown>;
  thumbnail?: string;
  sortOrder?: number;
}

export interface TemplateUpdate {
  name?: string;
  noteType?: 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';
  description?: string;
  content?: Record<string, unknown>;
  thumbnail?: string;
  sortOrder?: number;
}

// ── Template API ────────────────────────────────────

export const noteTemplateApi = {
  list: (params?: { note_type?: string; search?: string }) =>
    api.get<NoteTemplate[]>(`/notes/templates/list${buildQuery(params)}`),

  get: (id: string) => api.get<NoteTemplate>(`/notes/templates/${id}`),

  create: (data: TemplateCreate) => api.post<NoteTemplate>('/notes/templates', data),

  update: (id: string, data: TemplateUpdate) =>
    api.patch<NoteTemplate>(`/notes/templates/${id}`, data),

  delete: (id: string) => api.delete(`/notes/templates/${id}`),

  createNoteFrom: (templateId: string, opts?: { title?: string; folderId?: string }) =>
    api.post<Note>('/notes/templates/create-from', {
      template_id: templateId,
      title: opts?.title,
      folder_id: opts?.folderId,
    }),
};
