/**
 * 笔记离线缓存 —— 在线数据的旁路落盘与离线读取。
 *
 * 设计原则：
 * - 所有写入都是「旁路」：缓存失败绝不影响在线主流程；
 * - 所有读取都是「回退」：仅当网络请求失败时才使用，在线时永远以服务端为准；
 * - 用户绑定：缓存归属当前登录用户，切换账号自动清空，避免串数据。
 */
import type { Note, NoteFolder, NoteTag } from '../note';
import { noteApi } from '../note';
import {
  clearAll,
  countNotes,
  deleteNotes,
  ensureUser,
  estimateUsage,
  getAllNotes,
  getListSnapshot,
  getNote,
  putNotes,
  saveListSnapshot,
  type CachedNote,
  type ListSnapshot,
} from './offlineDb';

/** 当前绑定的用户 ID（缓存隔离依据） */
let activeUserId: string | null = null;

/**
 * 绑定当前登录用户。
 * 用户变化（含切换账号）时会清空不属于该用户的缓存。
 * @param userId 用户 ID；传 null 表示登出
 */
export async function bindUser(userId: string | null): Promise<void> {
  if (!userId) {
    activeUserId = null;
    return;
  }
  activeUserId = userId;
  await ensureUser(userId);
}

/**
 * 读取当前绑定的用户 ID。
 * @returns 用户 ID；未绑定时返回 null
 */
export function getActiveUserId(): string | null {
  return activeUserId;
}

/**
 * 把服务端笔记转换为缓存记录。
 * @param note 服务端笔记
 * @param userId 归属用户 ID
 * @param withContent 是否保留正文（列表缓存时传 false）
 * @returns 缓存记录
 */
function toCachedNote(note: Note, userId: string, withContent: boolean): CachedNote {
  return {
    id: note.id,
    userId,
    noteNo: note.noteNo ?? '',
    title: note.title ?? '',
    noteType: note.noteType,
    content: withContent ? note.content : undefined,
    folderId: note.folderId,
    description: note.description,
    previewText: note.previewText,
    tags: note.tags,
    isFavorite: note.isFavorite,
    isPinned: note.isPinned,
    status: note.status,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    cachedAt: Date.now(),
  };
}

/**
 * 缓存一批笔记的元数据（不含正文），供离线列表渲染。
 * @param notes 服务端笔记列表
 * @param userId 归属用户 ID
 */
export async function cacheNoteMetas(notes: Note[], userId: string): Promise<void> {
  if (notes.length === 0) return;
  await putNotes(notes.map((n) => toCachedNote(n, userId, false)));
}

/**
 * 缓存单条笔记（含正文），在编辑器成功拉取全文后调用。
 * @param note 服务端笔记（须含 content）
 * @param userId 归属用户 ID
 */
export async function cacheFullNote(note: Note, userId: string): Promise<void> {
  await putNotes([toCachedNote(note, userId, true)]);
}

/**
 * 写入列表页快照（笔记列表 + 文件夹 + 标签）。
 * @param notes 笔记列表
 * @param folders 文件夹列表
 * @param tags 标签列表
 * @param userId 归属用户 ID
 */
export async function cacheList(
  notes: Note[],
  folders: NoteFolder[],
  tags: NoteTag[],
  userId: string,
): Promise<void> {
  const snapshot: ListSnapshot = {
    userId,
    items: notes.map((n) => toCachedNote(n, userId, false)),
    folders,
    tags,
    cachedAt: Date.now(),
  };
  await saveListSnapshot(snapshot);
}

/**
 * 读取列表快照（离线时回退使用）。
 * @returns 快照；无缓存时返回 null
 */
export async function readList(): Promise<ListSnapshot | null> {
  return getListSnapshot();
}

/**
 * 读取单条笔记缓存。
 * @param id 笔记 ID
 * @returns 缓存记录；不存在时返回 null
 */
export async function readNote(id: string): Promise<CachedNote | null> {
  return getNote(id);
}

/**
 * 读取全部笔记缓存。
 * @returns 缓存记录列表（按更新时间倒序）
 */
export async function readAllNotes(): Promise<CachedNote[]> {
  const all = await getAllNotes();
  return all.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
}

/**
 * 在本地缓存中做关键词检索（离线搜索）。
 * 只匹配标题、描述与列表预览文本，不解析正文。
 * @param keyword 关键词
 * @returns 命中的缓存记录
 */
export async function searchCached(keyword: string): Promise<CachedNote[]> {
  const q = keyword.trim().toLowerCase();
  if (!q) return readAllNotes();
  const all = await getAllNotes();
  return all.filter((n) =>
    `${n.title} ${n.description ?? ''} ${n.previewText ?? ''}`.toLowerCase().includes(q),
  );
}

/**
 * 从本地缓存移除若干笔记（服务端已删除或本地已同步时调用）。
 * @param ids 笔记 ID 列表
 */
export async function dropCached(ids: string[]): Promise<void> {
  await deleteNotes(ids);
}

/**
 * 全量缓存所有笔记正文（用户在设置页手动触发）。
 * @param userId 归属用户 ID
 * @param onProgress 进度回调
 * @returns 成功缓存的条数
 */
export async function cacheAllNotes(
  userId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<number> {
  const PAGE_SIZE = 100;
  let skip = 0;
  let total = Number.POSITIVE_INFINITY;
  let done = 0;

  while (skip < total) {
    const res = await noteApi.list({ skip, limit: PAGE_SIZE, includeContent: true });
    total = res.total;
    if (res.items.length === 0) break;
    await putNotes(res.items.map((n) => toCachedNote(n, userId, true)));
    done += res.items.length;
    skip += PAGE_SIZE;
    onProgress?.(done, total);
  }
  return done;
}

/**
 * 读取缓存统计信息。
 * @returns 已缓存条数与存储占用
 */
export async function getCacheStats(): Promise<{
  count: number;
  usage: number;
  quota: number;
}> {
  const [count, estimate] = await Promise.all([countNotes(), estimateUsage()]);
  return { count, usage: estimate.usage, quota: estimate.quota };
}

/**
 * 清空全部离线缓存。
 */
export async function clearCache(): Promise<void> {
  await clearAll();
}

/**
 * 把缓存记录还原为界面使用的笔记对象。
 * @param cached 缓存记录
 * @returns 笔记对象
 */
export function toNote(cached: CachedNote): Note {
  return {
    id: cached.id,
    noteNo: cached.noteNo,
    title: cached.title,
    noteType: cached.noteType,
    content: cached.content,
    folderId: cached.folderId,
    description: cached.description,
    previewText: cached.previewText,
    tags: cached.tags,
    isFavorite: cached.isFavorite,
    isPinned: cached.isPinned ?? false,
    status: cached.status ?? 'active',
    isDeleted: false,
    createdAt: cached.createdAt,
    updatedAt: cached.updatedAt,
  };
}