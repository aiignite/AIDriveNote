import { api, fetchWithAuth } from './client';
import { keysToCamel } from '../utils/caseConverter';

export type KnowledgeStatus = 'pending_review' | 'approved' | 'merged' | 'ignored' | 'failed';

export interface KnowledgeSource {
  documentId: string;
  type: string;
  title: string;
  url: string | null;
  occurredAt: string | null;
  status: string;
  parser: string | null;
  parseMeta: Record<string, unknown>;
  error: string | null;
}

export interface KnowledgeEntity {
  name: string;
  type: string;
}

export interface KnowledgeClaim {
  text: string;
  sourceExcerpt?: string;
}

export interface KnowledgeCard {
  id: string;
  documentId: string;
  status: KnowledgeStatus;
  knowledgeType: string;
  title: string;
  summary: string;
  confidence: 'high' | 'medium' | 'low';
  keyPoints: string[];
  keywords: string[];
  entities: KnowledgeEntity[];
  claims: KnowledgeClaim[];
  topic: string;
  tags: string[];
  needsReview: boolean;
  mergeTarget: { noteId: string; title: string | null; score: number | null } | null;
  noteId: string | null;
  kbTarget: Record<string, unknown>;
  extractor: 'llm' | 'rule';
  model: string | null;
  createdAt: string | null;
  source: KnowledgeSource;
  rawText?: string;
  rawMeta?: Record<string, unknown>;
  decidedAt?: string | null;
}

export interface KnowledgeInboxResponse {
  items: KnowledgeCard[];
  nextCursor: string | null;
}

export interface KnowledgeStats {
  pendingReview: number;
  approved: number;
  merged: number;
  ignored: number;
  failed: number;
  total: number;
  llmCards?: number;
  tokensTotal?: number;
  tokensToday?: number;
}

export interface KnowledgeSettings {
  distillEnabled: boolean;
  allowExternal: boolean;
  dailyLimit: number;
  model: string | null;
  defaultModel?: string | null;
  configured: boolean;
  usedToday: number;
  tokensToday: number;
  tokensTotal: number;
}

export interface KnowledgeSourceText {
  rawText: string;
  rawMeta: Record<string, unknown>;
  source: KnowledgeSource;
}

export interface IngestResult {
  documentId: string;
  status: string;
  duplicate: boolean;
}

export interface KnowledgeLint {
  checked: number;
  missingSource: Array<{ noteId: string; title: string }>;
  duplicates: Array<{ title: string; noteIds: string[] }>;
  brokenLinks: Array<{ noteId: string; title: string; links: string[] }>;
  orphans: Array<{ noteId: string; title: string }>;
  counts: {
    missingSource: number;
    duplicates: number;
    brokenLinks: number;
    orphans: number;
  };
}

export const knowledgeApi = {
  listInbox: (options: {
    status?: string;
    sourceType?: string;
    cursor?: string | null;
    limit?: number;
  } = {}): Promise<KnowledgeInboxResponse> => {
    const params = new URLSearchParams();
    params.set('status', options.status || 'pending_review');
    if (options.sourceType) params.set('sourceType', options.sourceType);
    if (options.cursor) params.set('cursor', options.cursor);
    params.set('limit', String(options.limit ?? 20));
    return api.get<KnowledgeInboxResponse>(`/knowledge/inbox?${params.toString()}`);
  },

  getCard: (cardId: string): Promise<KnowledgeCard> =>
    api.get<KnowledgeCard>(`/knowledge/cards/${cardId}`),

  getCardSource: (cardId: string): Promise<KnowledgeSourceText> =>
    api.get<KnowledgeSourceText>(`/knowledge/cards/${cardId}/source`),

  approveCard: (
    cardId: string,
    body: {
      mode?: 'new' | 'merge';
      noteId?: string;
      folderId?: string;
      title?: string;
      tags?: string[];
    } = {},
  ): Promise<{ noteId: string; title: string; kbTarget: Record<string, unknown> }> =>
    api.post(`/knowledge/cards/${cardId}/approve`, body),

  ignoreCard: (cardId: string, reason?: string): Promise<{ id: string; status: string }> =>
    api.post(`/knowledge/cards/${cardId}/ignore`, { reason }),

  retryCard: (cardId: string): Promise<{ documentId: string; status: string }> =>
    api.post(`/knowledge/cards/${cardId}/retry`),

  batchCards: (
    cardIds: string[],
    action: 'approve' | 'ignore',
  ): Promise<{ results: Array<{ cardId: string; ok: boolean; noteId?: string; error?: string }> }> =>
    api.post('/knowledge/cards/batch', { cardIds, action }),

  updateKbStatus: (
    cardId: string,
    body: { status: string; path?: string },
  ): Promise<{ id: string; kbTarget: Record<string, unknown> }> =>
    api.patch(`/knowledge/cards/${cardId}/kb-status`, body),

  stats: (): Promise<KnowledgeStats> => api.get<KnowledgeStats>('/knowledge/stats'),

  getSettings: (): Promise<KnowledgeSettings> =>
    api.get<KnowledgeSettings>('/knowledge/settings'),

  updateSettings: (body: {
    distillEnabled?: boolean;
    allowExternal?: boolean;
    dailyLimit?: number;
    model?: string | null;
  }): Promise<KnowledgeSettings> => api.patch('/knowledge/settings', body),

  reindexDocument: (
    documentId: string,
  ): Promise<{ noteId: string; queued: boolean; mode?: 'v1' | 'v2' }> =>
    api.post(`/knowledge/documents/${documentId}/reindex`),

  createEntityPage: (
    cardId: string,
    body: { name: string; entityType?: string; topic?: string },
  ): Promise<{ noteId: string; title: string; created: boolean }> =>
    api.post(`/knowledge/cards/${cardId}/entity-page`, body),

  lint: (): Promise<KnowledgeLint> => api.get<KnowledgeLint>('/knowledge/lint'),

  distillNotes: (): Promise<{
    total: number;
    queued: number;
    duplicate: number;
    skipped: number;
  }> => api.post('/knowledge/distill/notes'),

  retryAllCards: (): Promise<{ documents: number }> =>
    api.post('/knowledge/cards/retry-all'),

  ingestDocument: (body: {
    sourceType?: string;
    externalId?: string;
    title?: string;
    text: string;
    url?: string;
    mime?: string;
    rawMeta?: Record<string, unknown>;
  }): Promise<IngestResult> => api.post('/ingest/documents', body),

  uploadDocument: async (
    file: File,
    options: { sourceType?: string; externalId?: string; title?: string; url?: string } = {},
  ): Promise<IngestResult> => {
    const params = new URLSearchParams();
    params.set('source_type', options.sourceType || 'upload');
    if (options.externalId) params.set('external_id', options.externalId);
    if (options.title) params.set('title', options.title);
    if (options.url) params.set('url', options.url);
    const form = new FormData();
    form.append('file', file);
    const res = await fetchWithAuth(`/ingest/documents/upload?${params.toString()}`, {
      method: 'POST',
      body: form,
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = text;
      try {
        detail = JSON.parse(text)?.detail ?? text;
      } catch {
        /* ignore */
      }
      throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
    }
    return keysToCamel(JSON.parse(text)) as IngestResult;
  },

  distillNote: (noteId: string): Promise<IngestResult> =>
    api.post(`/notes/${noteId}/distill`),
};
