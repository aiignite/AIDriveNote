import { useCallback, useEffect, useState } from 'react';
import { noteDocumentApi } from '../../../services/note/note';

interface CacheEntry {
  bytes: Uint8Array;
  at: number;
}

const CACHE = new Map<string, CacheEntry>();
const MAX_CACHE_BYTES = 60 * 1024 * 1024;
let cacheBytes = 0;

function cacheKey(noteId: string, etag: string): string {
  return `${noteId}:${etag}`;
}

function collect(bytes: Uint8Array): void {
  cacheBytes += bytes.byteLength;
  while (cacheBytes > MAX_CACHE_BYTES && CACHE.size > 1) {
    let oldestKey = '';
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [key, entry] of CACHE) {
      if (entry.at < oldestAt) {
        oldestAt = entry.at;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    const removed = CACHE.get(oldestKey);
    CACHE.delete(oldestKey);
    cacheBytes -= removed?.bytes.byteLength ?? 0;
  }
}

export interface DocumentBytesState {
  bytes: Uint8Array | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

/**
 * 取文档原文件字节：带会话内 LRU，避免切换笔记时重复下载。
 * 文档字节不写 IndexedDB，离线时直接提示需要联网。
 */
export function useDocumentBytes(params: {
  noteId: string;
  etag?: string | null;
  unlockToken?: string | null;
  publicToken?: string | null;
  enabled?: boolean;
}): DocumentBytesState {
  const { noteId, etag, unlockToken, publicToken, enabled = true } = params;
  const key = cacheKey(noteId, etag || '');
  const [bytes, setBytes] = useState<Uint8Array | null>(() => CACHE.get(key)?.bytes ?? null);
  const [loading, setLoading] = useState(enabled && !CACHE.has(key));
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  const reload = useCallback(() => {
    const existing = CACHE.get(key);
    if (existing) {
      cacheBytes -= existing.bytes.byteLength;
      CACHE.delete(key);
    }
    setVersion((value) => value + 1);
  }, [key]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return;
    }
    const cached = CACHE.get(key);
    if (cached) {
      setBytes(cached.bytes);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const load = async () => {
      const blob = publicToken
        ? await noteDocumentApi.publicFetchBytes(publicToken)
        : await noteDocumentApi.fetchBytes(noteId, unlockToken);
      const buffer = await blob.arrayBuffer();
      const next = new Uint8Array(buffer);
      if (cancelled) return;
      CACHE.set(key, { bytes: next, at: Date.now() });
      collect(next);
      setBytes(next);
      setLoading(false);
    };

    void load().catch((err: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : '原文件加载失败');
    });

    return () => {
      cancelled = true;
    };
  }, [enabled, key, noteId, publicToken, unlockToken, version]);

  return { bytes, loading, error, reload };
}
