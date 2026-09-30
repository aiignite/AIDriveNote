/**
 * 离线写入队列 —— 断网期间产生的增删改在恢复联网后按序回传服务端。
 *
 * 安全约束（继承项目既有教训：曾因批量判定失误软删过服务端笔记）：
 * - 删除必须带批量保护：单轮待同步的删除数超过阈值时只报告、不执行；
 * - 冲突不覆盖：服务端在离线期间被改过时，本地版本另存为「冲突副本」，绝不覆盖远端；
 * - 失败可恢复：业务错误重试到上限后停止自动重试，但本地缓存始终保留，数据不丢。
 */
import { isNetworkError } from '../client';
import { noteApi } from '../note';
import type { Note } from '../note';
import { cacheFullNote, dropCached } from './noteCache';
import {
  enqueueOp,
  listOps,
  putNotes,
  removeOp,
  updateOp,
  type CachedNote,
  type OutboxOp,
  type OutboxPayload,
} from './offlineDb';

/** 本地临时 ID 前缀：标识「离线新建、尚未回传服务端」的笔记 */
export const LOCAL_ID_PREFIX = 'local-';
/** 单轮同步允许自动执行的删除操作上限（超过则暂停并要求人工确认） */
export const DELETE_GUARD_LIMIT = 5;
/** 单条操作的自动重试上限 */
const MAX_ATTEMPTS = 3;

/** 冲突记录 */
export interface ConflictRecord {
  /** 冲突涉及的笔记 ID */
  noteId: string;
  /** 冲突笔记标题 */
  title: string;
  /** 冲突原因描述 */
  reason: string;
  /** 保留下来的本地副本 ID（若有） */
  copyId?: string;
}

/** 单轮队列回传的结果 */
export interface OutboxRunResult {
  /** 成功回传的操作数 */
  uploaded: number;
  /** 冲突记录 */
  conflicts: ConflictRecord[];
  /** 失败记录 */
  failed: { title: string; message: string }[];
  /** 是否因批量删除保护而暂停 */
  paused: boolean;
  /** 暂停原因 */
  pausedReason?: string;
}

/**
 * 生成用于命名冲突副本的时间戳。
 * @returns 形如 `20260930-221500` 的字符串
 */
function stamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * 生成一个本地唯一 ID。
 * 优先使用 crypto.randomUUID（安全上下文），不可用时退化为时间戳 + 随机数。
 * @returns 本地 ID
 */
function localId(): string {
  const uuid =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${LOCAL_ID_PREFIX}${uuid}`;
}

/**
 * 判断某个 ID 是否为本地临时 ID。
 * @param id 笔记 ID
 * @returns 是否为本地临时 ID
 */
export function isLocalId(id: string): boolean {
  return id.startsWith(LOCAL_ID_PREFIX);
}

// ── 离线写入入口 ──────────────────────────────────────

/**
 * 离线新建一条笔记（仅落本地，等待联网回传服务端）。
 * @param params.userId 归属用户 ID
 * @param params.title 标题
 * @param params.noteType 笔记类型
 * @param params.folderId 所属文件夹
 * @returns 新建的本地缓存记录
 */
export async function createOfflineNote(params: {
  userId: string;
  title: string;
  noteType: Note['noteType'];
  folderId?: string;
}): Promise<CachedNote> {
  const id = localId();
  const now = Date.now();
  const note: CachedNote = {
    id,
    userId: params.userId,
    noteNo: '待同步',
    title: params.title,
    noteType: params.noteType,
    content: undefined,
    folderId: params.folderId,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    cachedAt: now,
    pendingCreate: true,
  };
  await putNotes([note]);
  await enqueueOp({
    opId: localId(),
    noteId: id,
    type: 'create',
    payload: {
      title: params.title,
      noteType: params.noteType,
      folderId: params.folderId,
    },
    baseUpdatedAt: null,
    title: params.title,
    userId: params.userId,
    createdAt: now,
  });
  return note;
}

/**
 * 保存一次离线编辑：先写本地缓存，再入队等待回传。
 * 同一笔记的连续编辑会合并进同一条队列项，避免队列堆积。
 * @param params.note 当前缓存记录
 * @param params.payload 本次修改的字段
 */
export async function saveOfflineEdit(params: {
  note: CachedNote;
  payload: OutboxPayload;
}): Promise<void> {
  const { note, payload } = params;
  const merged: CachedNote = {
    ...note,
    ...payload,
    title: payload.title ?? note.title,
    cachedAt: Date.now(),
  };
  await putNotes([merged]);

  const ops = await listOps();

  // 尚未回传的本地新建笔记：直接把修改合并进 create 操作
  const createOp = ops.find((o) => o.type === 'create' && o.noteId === note.id);
  if (createOp) {
    await updateOp({ ...createOp, payload: { ...createOp.payload, ...payload } });
    return;
  }

  // 已有待回传的 update：合并载荷，保留最早的冲突基线
  const pendingUpdate = ops.find((o) => o.type === 'update' && o.noteId === note.id);
  if (pendingUpdate) {
    await updateOp({ ...pendingUpdate, payload: { ...pendingUpdate.payload, ...payload } });
    return;
  }

  await enqueueOp({
    opId: localId(),
    noteId: note.id,
    type: 'update',
    payload,
    baseUpdatedAt: note.updatedAt ?? null,
    title: merged.title,
    userId: note.userId,
    createdAt: Date.now(),
  });
}

/**
 * 删除一条笔记（离线语义：本地立即移除，服务端删除排队等待回传）。
 * @param note 目标缓存记录
 */
export async function deleteOfflineNote(note: CachedNote): Promise<void> {
  await dropCached([note.id]);

  // 本地新建、从未回传过的笔记：连同其队列项一起撤销，不需要请求服务端
  if (isLocalId(note.id)) {
    const ops = await listOps();
    for (const op of ops.filter((o) => o.noteId === note.id)) {
      await removeOp(op.opId);
    }
    return;
  }

  const ops = await listOps();
  // 已有待回传的修改：删除会覆盖掉这些修改，直接以删除为准，撤掉修改项
  for (const op of ops.filter((o) => o.noteId === note.id && o.type === 'update')) {
    await removeOp(op.opId);
  }

  await enqueueOp({
    opId: localId(),
    noteId: note.id,
    type: 'delete',
    payload: {},
    baseUpdatedAt: note.updatedAt ?? null,
    title: note.title,
    userId: note.userId,
    createdAt: Date.now(),
  });
}

// ── 队列回传 ──────────────────────────────────────────

/**
 * 把队列中所有操作按序回传服务端。
 * @returns 本轮回传结果
 */
export async function runOutbox(): Promise<OutboxRunResult> {
  const result: OutboxRunResult = { uploaded: 0, conflicts: [], failed: [], paused: false };
  const ops = await listOps();
  if (ops.length === 0) return result;

  // 批量删除保护：宁可让用户手动确认，也不冒批量误删服务端数据的风险
  const deleteCount = ops.filter((o) => o.type === 'delete').length;
  if (deleteCount > DELETE_GUARD_LIMIT) {
    result.paused = true;
    result.pausedReason =
      `本次待同步包含 ${deleteCount} 条删除操作，超过安全阈值 ${DELETE_GUARD_LIMIT} 条，` +
      '已暂停自动同步以避免误删。请确认无误后在离线设置中手动继续。';
    return result;
  }

  for (const op of ops) {
    try {
      await applyOp(op, result);
      await removeOp(op.opId);
      result.uploaded += 1;
    } catch (err) {
      if (isNetworkError(err)) {
        result.failed.push({ title: op.title, message: '网络中断，剩余操作将稍后重试' });
        break;
      }
      const attempts = (op.attempts ?? 0) + 1;
      const message = err instanceof Error ? err.message : '未知错误';
      if (attempts >= MAX_ATTEMPTS) {
        // 放弃自动重试，但本地缓存保留，用户仍能在离线状态看到内容
        await removeOp(op.opId);
        result.failed.push({
          title: op.title,
          message: `${message}（已自动重试 ${attempts} 次，本地内容仍保留在设备上）`,
        });
      } else {
        await updateOp({ ...op, attempts });
        result.failed.push({ title: op.title, message });
        break; // 连续失败通常意味着系统性问题，本轮到此为止
      }
    }
  }
  return result;
}

/**
 * 执行单条队列操作。
 * @param op 操作记录
 * @param result 累计结果（用于记录冲突）
 */
async function applyOp(op: OutboxOp, result: OutboxRunResult): Promise<void> {
  switch (op.type) {
    case 'create':
      await applyCreate(op);
      return;
    case 'update':
      await applyUpdate(op, result);
      return;
    case 'delete':
      await applyDelete(op, result);
      return;
  }
}

/**
 * 回传一条新建操作，并把本地临时 ID 迁移为服务端真实 ID。
 * @param op 操作记录
 */
async function applyCreate(op: OutboxOp): Promise<void> {
  const created = await noteApi.create({
    title: op.payload.title ?? '无标题笔记',
    noteType: op.payload.noteType ?? 'markdown',
    content: op.payload.content,
    folderId: op.payload.folderId,
    description: op.payload.description,
  });

  // 迁移：本地临时记录删除，真实记录写入；队列中后续引用同一临时 ID 的操作一并改写
  await dropCached([op.noteId]);
  await cacheFullNote(created, op.userId);

  const pending = await listOps();
  for (const other of pending.filter((o) => o.noteId === op.noteId && o.opId !== op.opId)) {
    if (other.type === 'delete') {
      // 本地新建后又被删除：服务端已建出这条记录，需要撤销
      await noteApi.delete(created.id);
      await dropCached([created.id]);
      await removeOp(other.opId);
      continue;
    }
    await updateOp({
      ...other,
      noteId: created.id,
      baseUpdatedAt: created.updatedAt ?? null,
    });
  }
}

/**
 * 回传一条修改操作；检测到双端同时修改时保留冲突副本而不覆盖远端。
 * @param op 操作记录
 * @param result 累计结果
 */
async function applyUpdate(op: OutboxOp, result: OutboxRunResult): Promise<void> {
  const remote = await noteApi.get(op.noteId);

  if (op.baseUpdatedAt && remote.updatedAt && remote.updatedAt !== op.baseUpdatedAt) {
    // 冲突：服务端在离线期间被改过。把本地版本另存为副本，不做覆盖。
    const copy = await noteApi.create({
      title: `${op.title}（冲突副本 ${stamp()}）`,
      noteType: remote.noteType,
      content: op.payload.content,
      folderId: op.payload.folderId ?? remote.folderId,
      description: op.payload.description,
    });
    await cacheFullNote(copy, op.userId);
    result.conflicts.push({
      noteId: op.noteId,
      title: op.title,
      reason: '服务端在离线期间已被修改，本地版本已另存为冲突副本，未覆盖远端内容',
      copyId: copy.id,
    });
    return;
  }

  const updated = await noteApi.update(op.noteId, {
    title: op.payload.title,
    content: op.payload.content,
    folderId: op.payload.folderId,
    description: op.payload.description,
    isPinned: op.payload.isPinned,
  });
  await cacheFullNote(updated, op.userId);
}

/**
 * 回传一条删除操作；服务端在离线期间被改过时跳过删除并报告冲突。
 * @param op 操作记录
 * @param result 累计结果
 */
async function applyDelete(op: OutboxOp, result: OutboxRunResult): Promise<void> {
  const remote = await noteApi.get(op.noteId);

  if (op.baseUpdatedAt && remote.updatedAt && remote.updatedAt !== op.baseUpdatedAt) {
    result.conflicts.push({
      noteId: op.noteId,
      title: op.title,
      reason: '服务端在离线期间已被修改，已跳过该删除操作。若仍需删除请在笔记列表中手动执行',
    });
    // 本地缓存已在删除时移除，这里补回，避免用户看不到这条笔记
    await cacheFullNote(remote, op.userId);
    return;
  }

  await noteApi.delete(op.noteId);
  await dropCached([op.noteId]);
}