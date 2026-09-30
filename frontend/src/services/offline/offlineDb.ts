/**
 * 离线数据层 —— 基于 IndexedDB 的本地笔记缓存与离线写入队列。
 *
 * 职责：
 * - 缓存笔记正文与列表快照，让断网时仍能浏览全部已缓存内容；
 * - 维护「离线写入队列」（outbox），记录断网期间发生的增删改，联网后按序回传服务端；
 * - 按 userId 隔离数据，避免同一浏览器切换账号后读到上一个用户的内容。
 *
 * 说明：本文件只负责「存」，不负责「同步语义」。
 * 队列的重放、冲突判定与批量保护在 offlineQueue.ts 中实现。
 */
import type { Note, NoteTag, NoteFolder } from '../note';

/** IndexedDB 数据库名 */
const DB_NAME = 'aidrivenote-offline';
/** 数据库结构版本 */
const DB_VERSION = 1;
/** 键值元数据仓库 */
const STORE_META = 'meta';
/** 笔记缓存仓库（主键为笔记 ID） */
const STORE_NOTES = 'notes';
/** 列表快照仓库（主键固定为 main） */
const STORE_LISTS = 'lists';
/** 离线写入队列仓库（主键为 opId） */
const STORE_OUTBOX = 'outbox';
/** 列表快照的固定主键 */
const LIST_KEY = 'main';
/** 元数据：当前缓存归属的用户 ID */
export const META_USER_ID = 'userId';
/** 元数据：上次成功缓存的列表时间（毫秒时间戳） */
export const META_LAST_SYNC = 'lastSyncAt';

/** 离线缓存中的一条笔记 */
export interface CachedNote {
  /** 笔记 ID（离线新建时为本地临时 ID，形如 local-xxx） */
  id: string;
  /** 归属用户 ID，用于多账号隔离 */
  userId: string;
  /** 笔记编号（离线新建时为空） */
  noteNo: string;
  /** 标题 */
  title: string;
  /** 笔记类型 */
  noteType: Note['noteType'];
  /** 正文（列表缓存时不写入） */
  content?: Record<string, unknown>;
  /** 所属文件夹 ID */
  folderId?: string;
  /** 描述 */
  description?: string;
  /** 列表页预览纯文本 */
  previewText?: string;
  /** 标签 */
  tags?: NoteTag[];
  /** 是否收藏 */
  isFavorite?: boolean;
  /** 是否置顶 */
  isPinned?: boolean;
  /** 状态 */
  status?: string;
  /** 服务端创建时间 */
  createdAt?: string;
  /** 服务端最后更新时间（冲突检测基线） */
  updatedAt?: string;
  /** 本地写入缓存的时间（毫秒），用于判断数据新鲜度 */
  cachedAt: number;
  /** 是否为离线新建、尚未回传服务端的本地笔记 */
  pendingCreate?: boolean;
}

/** 列表页快照（不含正文，体积可控） */
export interface ListSnapshot {
  /** 归属用户 ID */
  userId: string;
  /** 笔记列表（不含 content） */
  items: CachedNote[];
  /** 文件夹列表 */
  folders: NoteFolder[];
  /** 标签列表 */
  tags: NoteTag[];
  /** 快照写入时间（毫秒） */
  cachedAt: number;
}

/** 离线写入操作类型 */
export type OutboxOpType = 'create' | 'update' | 'delete';

/** 离线写入操作的载荷 */
export interface OutboxPayload {
  /** 标题 */
  title?: string;
  /** 正文 */
  content?: Record<string, unknown>;
  /** 笔记类型（仅新建时有意义） */
  noteType?: Note['noteType'];
  /** 所属文件夹 */
  folderId?: string;
  /** 描述 */
  description?: string;
  /** 是否置顶 */
  isPinned?: boolean;
}

/** 待同步的一条离线写入操作 */
export interface OutboxOp {
  /** 操作 ID（本地生成），用于幂等去重与日志追踪 */
  opId: string;
  /** 目标笔记 ID；create 时为本地临时 ID */
  noteId: string;
  /** 操作类型 */
  type: OutboxOpType;
  /** 写入载荷 */
  payload: OutboxPayload;
  /** 入队时客户端已知的服务端 updatedAt，作为冲突检测基线 */
  baseUpdatedAt: string | null;
  /** 入队时的笔记标题，用于同步报告展示 */
  title: string;
  /** 归属用户 ID */
  userId: string;
  /** 入队时间（毫秒），队列按此升序重放 */
  createdAt: number;
  /** 已尝试回传次数，超过上限后不再自动重试，转为人工处理 */
  attempts?: number;
}

/** 缓存的数据库连接（避免每次操作都重新打开） */
let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * 特性检测：当前环境是否可用 IndexedDB（隐私模式、无痕窗口下可能不可用）。
 * @returns 是否可用
 */
export function isSupported(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * 打开（必要时初始化）离线数据库。
 * 连接会被复用；遇到版本变更时自动关闭并让下次调用重新打开。
 * @returns 数据库连接
 */
function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
      if (!db.objectStoreNames.contains(STORE_NOTES)) {
        db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_LISTS)) {
        db.createObjectStore(STORE_LISTS);
      }
      if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
        db.createObjectStore(STORE_OUTBOX, { keyPath: 'opId' });
      }
    };

    request.onsuccess = () => {
      const db = request.result;
      // 其它标签页升级数据库版本时，本连接必须让路，否则升级会被阻塞
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('打开离线数据库失败'));
    };
  });
  return dbPromise;
}

/**
 * 把一次 IDBRequest 包装为 Promise。
 * @param request IndexedDB 请求
 * @returns 请求结果
 */
function toPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('离线数据库请求失败'));
  });
}

/**
 * 在指定仓库上执行一次事务。
 * 事务完成信号在事务体执行前就已绑定，避免事务提前提交导致 Promise 永久挂起。
 * @param storeNames 参与事务的仓库名列表
 * @param mode 事务模式
 * @param executor 事务体，通过 get() 取得仓库并同步发起请求
 * @returns 事务体返回的结果
 */
async function runTransaction<T>(
  storeNames: string[],
  mode: IDBTransactionMode,
  executor: (get: (name: string) => IDBObjectStore) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const transaction = db.transaction(storeNames, mode);
  const done = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('离线数据库事务失败'));
    transaction.onabort = () => reject(transaction.error ?? new Error('离线数据库事务被中止'));
  });
  const result = await executor((name) => transaction.objectStore(name));
  await done;
  return result;
}

// ── 元数据 ────────────────────────────────────────────

/**
 * 读取一条元数据。
 * @param key 元数据键
 * @returns 值；不存在时返回 null
 */
export async function getMeta<T>(key: string): Promise<T | null> {
  if (!isSupported()) return null;
  try {
    return await runTransaction([STORE_META], 'readonly', async (get) => {
      const value = await toPromise(get(STORE_META).get(key));
      return (value as T | undefined) ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * 写入一条元数据。
 * @param key 元数据键
 * @param value 值
 */
export async function setMeta(key: string, value: unknown): Promise<void> {
  if (!isSupported()) return;
  try {
    await runTransaction([STORE_META], 'readwrite', async (get) => {
      await toPromise(get(STORE_META).put(value, key));
    });
  } catch {
    /* 元数据写入失败不影响主流程 */
  }
}

/**
 * 校验并绑定当前缓存归属的用户。
 * 若缓存属于其它用户（同浏览器切换账号），则整体清空后重新绑定。
 * @param userId 当前登录用户 ID
 * @returns 是否发生了清空
 */
export async function ensureUser(userId: string): Promise<boolean> {
  const cached = await getMeta<string>(META_USER_ID);
  if (cached === userId) return false;
  if (cached !== null) {
    await clearAll();
  }
  await setMeta(META_USER_ID, userId);
  return cached !== null;
}

// ── 笔记缓存 ──────────────────────────────────────────

/**
 * 批量写入或更新笔记缓存。
 * @param notes 待写入的笔记记录
 */
export async function putNotes(notes: CachedNote[]): Promise<void> {
  if (!isSupported() || notes.length === 0) return;
  try {
    await runTransaction([STORE_NOTES], 'readwrite', async (get) => {
      const store = get(STORE_NOTES);
      for (const note of notes) {
        store.put(note);
      }
    });
  } catch {
    /* 缓存写入失败不影响在线主流程 */
  }
}

/**
 * 读取单条笔记缓存。
 * @param id 笔记 ID
 * @returns 缓存记录；不存在时返回 null
 */
export async function getNote(id: string): Promise<CachedNote | null> {
  if (!isSupported()) return null;
  try {
    return await runTransaction([STORE_NOTES], 'readonly', async (get) => {
      const value = await toPromise(get(STORE_NOTES).get(id));
      return (value as CachedNote | undefined) ?? null;
    });
  } catch {
    return null;
  }
}

/**
 * 读取全部笔记缓存。
 * @returns 缓存记录列表
 */
export async function getAllNotes(): Promise<CachedNote[]> {
  if (!isSupported()) return [];
  try {
    return await runTransaction([STORE_NOTES], 'readonly', async (get) => {
      const values = await toPromise(get(STORE_NOTES).getAll());
      return (values as CachedNote[]) ?? [];
    });
  } catch {
    return [];
  }
}

/**
 * 批量删除笔记缓存。
 * @param ids 待删除的笔记 ID 列表
 */
export async function deleteNotes(ids: string[]): Promise<void> {
  if (!isSupported() || ids.length === 0) return;
  try {
    await runTransaction([STORE_NOTES], 'readwrite', async (get) => {
      const store = get(STORE_NOTES);
      for (const id of ids) {
        store.delete(id);
      }
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 统计已缓存笔记条数。
 * @returns 条数
 */
export async function countNotes(): Promise<number> {
  if (!isSupported()) return 0;
  try {
    return await runTransaction([STORE_NOTES], 'readonly', async (get) =>
      toPromise(get(STORE_NOTES).count()),
    );
  } catch {
    return 0;
  }
}

// ── 列表快照 ──────────────────────────────────────────

/**
 * 写入列表页快照（笔记列表 + 文件夹 + 标签）。
 * @param snapshot 快照内容
 */
export async function saveListSnapshot(snapshot: ListSnapshot): Promise<void> {
  if (!isSupported()) return;
  try {
    await runTransaction([STORE_LISTS, STORE_META], 'readwrite', async (get) => {
      get(STORE_LISTS).put(snapshot, LIST_KEY);
      get(STORE_META).put(snapshot.cachedAt, META_LAST_SYNC);
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 读取列表页快照。
 * @returns 快照；不存在时返回 null
 */
export async function getListSnapshot(): Promise<ListSnapshot | null> {
  if (!isSupported()) return null;
  try {
    return await runTransaction([STORE_LISTS], 'readonly', async (get) => {
      const value = await toPromise(get(STORE_LISTS).get(LIST_KEY));
      return (value as ListSnapshot | undefined) ?? null;
    });
  } catch {
    return null;
  }
}

// ── 离线写入队列 ──────────────────────────────────────

/**
 * 入队一条离线写入操作。
 * @param op 操作记录
 */
export async function enqueueOp(op: OutboxOp): Promise<void> {
  if (!isSupported()) return;
  await runTransaction([STORE_OUTBOX], 'readwrite', async (get) => {
    get(STORE_OUTBOX).put(op);
  });
}

/**
 * 读取全部待同步操作，按入队时间升序（保证重放顺序与用户操作顺序一致）。
 * @returns 操作列表
 */
export async function listOps(): Promise<OutboxOp[]> {
  if (!isSupported()) return [];
  try {
    const ops = await runTransaction([STORE_OUTBOX], 'readonly', async (get) => {
      const values = await toPromise(get(STORE_OUTBOX).getAll());
      return (values as OutboxOp[]) ?? [];
    });
    return ops.sort((a, b) => a.createdAt - b.createdAt);
  } catch {
    return [];
  }
}

/**
 * 更新一条队列操作（用于重试计数等）。
 * @param op 操作记录
 */
export async function updateOp(op: OutboxOp): Promise<void> {
  await enqueueOp(op);
}

/**
 * 移除一条队列操作（同步成功后调用）。
 * @param opId 操作 ID
 */
export async function removeOp(opId: string): Promise<void> {
  if (!isSupported()) return;
  try {
    await runTransaction([STORE_OUTBOX], 'readwrite', async (get) => {
      get(STORE_OUTBOX).delete(opId);
    });
  } catch {
    /* 忽略 */
  }
}

/**
 * 统计待同步操作数量。
 * @returns 条数
 */
export async function countOps(): Promise<number> {
  if (!isSupported()) return 0;
  try {
    return await runTransaction([STORE_OUTBOX], 'readonly', async (get) =>
      toPromise(get(STORE_OUTBOX).count()),
    );
  } catch {
    return 0;
  }
}

// ── 维护 ──────────────────────────────────────────────

/**
 * 估算浏览器分配给本站点的存储占用。
 * @returns 已用字节数与配额字节数；不可用时均为 0
 */
export async function estimateUsage(): Promise<{ usage: number; quota: number }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

/**
 * 清空全部离线数据（登出、切换账号、用户手动清理时调用）。
 */
export async function clearAll(): Promise<void> {
  if (!isSupported()) return;
  try {
    await runTransaction(
      [STORE_META, STORE_NOTES, STORE_LISTS, STORE_OUTBOX],
      'readwrite',
      async (get) => {
        get(STORE_META).clear();
        get(STORE_NOTES).clear();
        get(STORE_LISTS).clear();
        get(STORE_OUTBOX).clear();
      },
    );
  } catch {
    /* 忽略 */
  }
}