import { API_BASE, api, buildQuery, fetchWithAuth } from '../client';
import { keysToCamel } from '../../utils/caseConverter';
import { buildUnlockHeader } from './unlockStore';
import type { NoteType } from './noteTypes';

export type { NoteType } from './noteTypes';
export { NOTE_TYPE_LABEL, NOTE_TYPES, EDITABLE_NOTE_TYPES, isDocumentType } from './noteTypes';

// ── 类型定义 ──────────────────────────────────────────────

export interface NoteDocumentMeta {
  fileName: string;
  mime: string;
  ext: string;
  sizeBytes: number;
  pageCount?: number | null;
  etag: string;
  viewable: boolean;
  extractStatus: string;
}

export interface NoteTag {
  id: string;
  name: string;
  color: string;
}

export interface Note {
  id: string;
  noteNo: string;
  title: string;
  noteType: NoteType;
  content?: Record<string, unknown>;
  document?: NoteDocumentMeta | null;
  folderId?: string;
  description?: string;
  status: string;
  isPinned: boolean;
  isDeleted: boolean;
  deletedAt?: string;
  previewText?: string;
  isFavorite?: boolean;
  tags?: NoteTag[];
  /** 该笔记是否启用了笔记级加密 */
  isEncrypted?: boolean;
  /** RAG 索引状态：pending / ok / failed / skipped */
  indexStatus?: string | null;
  /** 当前请求是否处于锁定态（自身加密或受加密文件夹保护且未解锁） */
  isLocked?: boolean;
  /** 锁定来源：note（笔记自身）/ folder（加密文件夹） */
  lockedScope?: 'note' | 'folder' | null;
  /** 锁定对象 ID */
  lockedId?: string | null;
  createdBy?: string;
  updatedBy?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface NoteCreate {
  title: string;
  noteType: NoteType;
  content?: Record<string, unknown>;
  folderId?: string;
  description?: string;
  status?: string;
}

export interface NoteUpdate {
  title?: string;
  noteType?: NoteType;
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
  /** 是否启用了文件夹级加密 */
  isEncrypted?: boolean;
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
  /** 默认 false：列表响应不含 content，显著减小文件树加载体积；导出等场景需显式开启 */
  includeContent?: boolean;
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

export interface KnowledgeSearchMeta {
  summary?: string | null;
  keywords: string[];
  sourceType?: string | null;
  knowledgeType?: string | null;
  confidence?: string | null;
}

export interface NoteSearchResponse {
  items: Note[];
  total: number;
  highlights: Record<string, string>;
  knowledge?: Record<string, KnowledgeSearchMeta>;
}

export interface RelatedNote {
  id: string;
  noteNo?: string | null;
  title: string;
  noteType: string;
  snippet: string;
  score: number;
  linked: boolean;
}

export interface TagSuggestion {
  name: string;
  color?: string | null;
  existing: boolean;
  score: number;
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
      include_content: params.includeContent,
    } : undefined)}`),

  listTrash: (params?: { skip?: number; limit?: number; search?: string }) =>
    api.get<NoteListResponse>(`/notes/trash/list${buildQuery(params)}`),

  search: (q: string, params?: { skip?: number; limit?: number; include_shared?: boolean }) =>
    api.get<NoteSearchResponse>(`/notes/search/fulltext${buildQuery({
      q,
      skip: params?.skip,
      limit: params?.limit,
      include_shared: params?.include_shared,
    })}`),

  get: (id: string, unlockToken?: string | null) =>
    api.get<Note>(`/notes/${id}`, buildUnlockHeader(unlockToken)),

  getChunk: (noteId: string, chunkId: string) =>
    api.get<{ chunkId: string; noteId: string; headingPath?: string | null; content: string; title: string }>(
      `/notes/${noteId}/chunks/${chunkId}`,
    ),

  related: (id: string, limit = 6) =>
    api.get<RelatedNote[]>(`/notes/${id}/related?limit=${limit}`),

  linkRelated: (id: string, targetId: string) =>
    api.post<{ success: boolean }>(`/notes/${id}/related/${targetId}/link`, {}),

  tagSuggestions: (id: string, limit = 5) =>
    api.get<TagSuggestion[]>(`/notes/${id}/tag-suggestions?limit=${limit}`),

  createPublicLink: (id: string) =>
    api.post<{ token: string; expiresAt?: string | null }>(`/notes/${id}/public-link`, {}),

  revokePublicLink: (id: string) =>
    api.delete<{ success: boolean; revoked: number }>(`/notes/${id}/public-link`),

  dailyToday: (date?: string) =>
    api.get<Note>(`/notes/daily/today${date ? `?date=${encodeURIComponent(date)}` : ''}`),

  dailyReview: (date?: string) =>
    api.post<{ date: string; markdown: string; noteCount: number; model?: string | null }>(
      `/notes/daily/review${date ? `?date=${encodeURIComponent(date)}` : ''}`,
      {},
    ),

  publicGet: (token: string) =>
    api.get<{
      title: string;
      noteType: string;
      content: unknown;
      description?: string | null;
      document?: NoteDocumentMeta | null;
      updatedAt?: string | null;
    }>(`/public/notes/${encodeURIComponent(token)}`),

  create: (data: NoteCreate) => api.post<Note>('/notes', data),

  update: (id: string, data: NoteUpdate, unlockToken?: string | null) =>
    api.patch<Note>(`/notes/${id}`, data, buildUnlockHeader(unlockToken)),

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

// ── 文档笔记 API ──────────────────────────────────────

export interface DocumentUploadOptions {
  title?: string;
  folderId?: string;
  description?: string;
}

async function readError(res: Response): Promise<string> {
  const text = await res.text().catch(() => '');
  try {
    const detail = JSON.parse(text)?.detail;
    if (typeof detail === 'string') return detail;
  } catch {
    /* ignore */
  }
  return text || `请求失败（${res.status}）`;
}

export const noteDocumentApi = {
  /** 上传 PDF / Office / HTML，生成文档笔记。 */
  upload: async (file: File, opts: DocumentUploadOptions = {}): Promise<Note> => {
    const form = new FormData();
    form.append('file', file);
    if (opts.title) form.append('title', opts.title);
    if (opts.folderId) form.append('folder_id', opts.folderId);
    if (opts.description) form.append('description', opts.description);
    const res = await fetchWithAuth('/notes/documents', { method: 'POST', body: form });
    if (!res.ok) throw new Error(await readError(res));
    const text = await res.text();
    return keysToCamel<Note>(text ? JSON.parse(text) : {});
  },

  /** 取回原文件字节；锁定笔记需带解锁票据。 */
  fetchBytes: async (noteId: string, unlockToken?: string | null): Promise<Blob> => {
    const res = await fetchWithAuth(`/notes/${noteId}/document`, {
      headers: buildUnlockHeader(unlockToken),
    });
    if (!res.ok) throw new Error(await readError(res));
    return res.blob();
  },

  /** 公开分享页取回原文件字节（无鉴权，仅 token）。 */
  publicFetchBytes: async (token: string): Promise<Blob> => {
    const res = await fetch(
      `${API_BASE}/public/notes/${encodeURIComponent(token)}/document`,
    );
    if (!res.ok) throw new Error(await readError(res));
    return res.blob();
  },
};

// ── 加密文档 API ──────────────────────────────────────

/** 笔记加/解密、解锁响应 */
export interface NoteLockResult {
  note: Note;
  /** 解锁票据；仅解锁 / 加密 / 改密成功时返回 */
  unlockToken?: string;
}

/** 文件夹加/解密、解锁响应 */
export interface FolderLockResult {
  folder: NoteFolder;
  unlockToken?: string;
  /** 受影响的笔记数量（加密 / 解密时有效） */
  affected: number;
}

export const noteLockApi = {
  /** 给笔记设置密码并加密正文 */
  encrypt: (id: string, password: string) =>
    api.post<NoteLockResult>(`/notes/${id}/encrypt`, { password }),

  /** 取消笔记加密（需正确密码） */
  decrypt: (id: string, password: string) =>
    api.post<NoteLockResult>(`/notes/${id}/decrypt`, { password }),

  /** 校验密码并换取解锁票据 */
  unlock: (id: string, password: string) =>
    api.post<NoteLockResult>(`/notes/${id}/unlock`, { password }),

  /** 修改加密密码 */
  changePassword: (id: string, oldPassword: string, newPassword: string) =>
    api.post<NoteLockResult>(`/notes/${id}/change-password`, {
      old_password: oldPassword,
      new_password: newPassword,
    }),
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

  /** 加密文件夹：为其子树内笔记用文件夹密钥重新加密 */
  encrypt: (id: string, password: string) =>
    api.post<FolderLockResult>(`/notes/folders/${id}/encrypt`, { password }),

  /** 校验文件夹密码并换取解锁票据 */
  unlock: (id: string, password: string) =>
    api.post<FolderLockResult>(`/notes/folders/${id}/unlock`, { password }),

  /** 取消文件夹加密：还原子树内笔记正文 */
  decrypt: (id: string, password: string) =>
    api.post<FolderLockResult>(`/notes/folders/${id}/decrypt`, { password }),
};

// ── Note Email API ─────────────────────────────────────

export interface NoteEmailSendPayload {
  /** 目标笔记 ID */
  noteId: string;
  /** 收件人地址，支持逗号分隔多个 */
  to: string;
  /** 邮件标题；留空则用笔记标题 */
  subject?: string;
  /** 附言；留空则不带 */
  message?: string;
}

export interface NoteEmailSendResult {
  sent: boolean;
  recipients: string[];
  subject: string;
  /** true 表示后端处于 EMAIL_MOCK 模式，只记日志未真实发送 */
  mocked: boolean;
}

export const noteEmailApi = {
  /** 把笔记渲染为 HTML 正文并发送 */
  sendNote: (payload: NoteEmailSendPayload) =>
    api.post<NoteEmailSendResult>('/notes/email/send', {
      note_id: payload.noteId,
      to: payload.to,
      subject: payload.subject ?? null,
      message: payload.message ?? null,
    }),
};

// ── Note Title API ────────────────────────────────────

export interface NoteTitleSuggestResult {
  /** 建议标题；空字符串表示无法生成 */
  title: string;
}

export const noteTitleApi = {
  /** 从内容推导标题（不调模型） */
  derive: (noteId: string) => api.post<NoteTitleSuggestResult>(`/notes/title/derive/${noteId}`, {}),

  /** 调用 AI 生成标题建议 */
  generate: (noteId: string, opts?: { assistantModel?: string; requestModel?: string }) =>
    api.post<NoteTitleSuggestResult>('/notes/title/generate', {
      note_id: noteId,
      assistant_model: opts?.assistantModel ?? null,
      request_model: opts?.requestModel ?? null,
    }),
};

// ── Template Types ──────────────────────────────────

export interface NoteTemplate {
  id: string;
  name: string;
  noteType: NoteType;
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
  noteType: NoteType;
  description?: string;
  content?: Record<string, unknown>;
  thumbnail?: string;
  sortOrder?: number;
}

export interface TemplateUpdate {
  name?: string;
  noteType?: NoteType;
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
