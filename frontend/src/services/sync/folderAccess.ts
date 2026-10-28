/**
 * 本机目录访问层 —— 封装 File System Access API 与权限生命周期。
 *
 * 职责：
 * - 特性检测（仅 Chromium 桌面浏览器支持 `showDirectoryPicker`）
 * - 让用户选择本地文件夹，并把目录句柄持久化到 IndexedDB（下次打开无需重选）
 * - 按「相对路径」读写文件、建目录、列目录、遍历文件树
 * - 删除语义：一律先复制到 `.aidrivenote/trash/` 再移除原位置，绝不静默丢用户数据
 *
 * 两个同步源（notes / kb）各持有独立句柄与目录名镜像，互不覆盖。
 *
 * 说明：`lib.dom.d.ts` 未声明 `showDirectoryPicker` / `queryPermission` / `requestPermission` /
 * `entries()` 等成员，故在本文件内自行补充类型，不污染全局声明。
 */
import { LEGACY_HANDLE_TARGET_KEY, type SyncSourceKey } from './kbConfig';

/** 权限状态（对应浏览器 FileSystemPermissionState） */
export type FsPermissionState = 'granted' | 'denied' | 'prompt';

/** 权限模式 */
export type FsPermissionMode = 'read' | 'readwrite';

/** 目录条目（本应用只关心名字与类型） */
export interface DirEntry {
  /** 条目标识名 */
  name: string;
  /** 条目类型 */
  kind: FileSystemHandleKind;
}

/**
 * 具备权限 API 与目录遍历能力的目录句柄。
 * 浏览器实际实现了这些成员，但 TypeScript 默认 DOM 类型里没有，故在此扩充。
 */
export interface SyncDirectoryHandle extends FileSystemDirectoryHandle {
  queryPermission(descriptor?: { mode?: FsPermissionMode }): Promise<FsPermissionState>;
  requestPermission(descriptor?: { mode?: FsPermissionMode }): Promise<FsPermissionState>;
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>;
  /** 计算另一个句柄相对本目录的路径；无包含关系时返回 null */
  resolve(possibleDescendant: FileSystemHandle): Promise<string[] | null>;
}

/** 目录选择器函数签名 */
type DirectoryPicker = (options?: {
  id?: string;
  mode?: FsPermissionMode;
  startIn?: string;
}) => Promise<FileSystemDirectoryHandle>;

/** IndexedDB 数据库名 */
const DB_NAME = 'aidrivenote-sync';
/** IndexedDB 版本 */
const DB_VERSION = 1;
/** 存放句柄的对象仓库名 */
const STORE_HANDLES = 'handles';
/** 目录句柄在仓库里的主键前缀（按同步源区分） */
const HANDLE_KEY_PREFIX = 'dir:';
/** 旧版单根目录句柄主键，仅用于一次性迁移 */
const LEGACY_HANDLE_KEY = 'dir';
/** 目录名镜像的 localStorage 键前缀（按同步源区分） */
const NAME_MIRROR_PREFIX = 'aidrivenote.sync.dirName.';
/** 旧版目录名镜像键，仅用于一次性迁移 */
const LEGACY_NAME_MIRROR_KEY = 'aidrivenote.sync.dirName';
/** 应用内部数据目录名（manifest 与回收站都放这里） */
export const APP_DIR = '.aidrivenote';
/** 回收站目录（相对应用数据目录） */
const TRASH_DIR = 'trash';
/** 空白解码器：用于写入前判断文件是否为空 */
const TEXT_DECODER = new TextDecoder();

/**
 * 取出浏览器原生目录选择器；不存在时返回 null。
 * @returns 目录选择器函数或 null
 */
function getDirectoryPicker(): DirectoryPicker | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { showDirectoryPicker?: DirectoryPicker };
  return w.showDirectoryPicker ?? null;
}

/**
 * 判断错误是否为用户主动取消（选择器弹窗点「取消」）。
 * @param err 捕获到的异常
 * @returns 是否属于取消操作
 */
function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * 判断错误是否为「条目不存在」。
 * @param err 捕获到的异常
 * @returns 是否属于 NotFoundError
 */
function isNotFoundError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'NotFoundError';
}

/**
 * 判断错误是否为「类型不匹配」（把目录当文件、或把文件当目录访问）。
 * @param err 捕获到的异常
 * @returns 是否属于 TypeMismatchError
 */
function isTypeMismatchError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'TypeMismatchError';
}

/**
 * 特性检测：当前浏览器是否支持 File System Access API 的目录选择。
 * 需要在安全上下文（HTTPS 或 localhost）下才可用。
 * @returns 是否支持
 */
export function isSupported(): boolean {
  if (typeof window === 'undefined') return false;
  if (!window.isSecureContext) return false;
  return getDirectoryPicker() !== null;
}

/**
 * 弹出目录选择器，让用户授权一个本地文件夹（读写权限）。
 * @param key 同步源标识；不同源使用不同的选择器记忆，避免下次从错误目录开始
 * @param startIn 选择器初始位置（如 `documents`），仅作为建议
 * @returns 授权后的目录句柄；用户取消时返回 null
 */
export async function pickDirectory(
  key: SyncSourceKey = 'notes',
  startIn?: string,
): Promise<SyncDirectoryHandle | null> {
  const picker = getDirectoryPicker();
  if (!picker) throw new Error('当前浏览器不支持选择本地文件夹');
  try {
    const handle = await picker({ id: `aidrivenote-${key}`, mode: 'readwrite', startIn });
    return handle as SyncDirectoryHandle;
  } catch (err) {
    if (isAbortError(err)) return null;
    throw err;
  }
}

/**
 * 打开（或首次创建）IndexedDB 句柄库。
 * @returns 已就绪的数据库连接
 */
function openHandleDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) {
        db.createObjectStore(STORE_HANDLES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('打开 IndexedDB 失败'));
  });
}

/** 同步源的 IndexedDB 主键 */
function handleKey(key: SyncSourceKey): string {
  return `${HANDLE_KEY_PREFIX}${key}`;
}

/**
 * 把目录句柄持久化到 IndexedDB。
 * 目录句柄是可结构化克隆对象，因此可以直接入库，用户下次打开无需重新选目录。
 *
 * ⚠️ IndexedDB 在浏览器眼里属于「尽力而为」的缓存：站点存储紧张时整个库可能被直接回收，
 * 目录句柄随之丢失，用户就得重新选一次文件夹。因此这里同时申请持久化存储，
 * 并把目录名镜像到 localStorage 兜底（见 `requestPersistentStorage` 与 `saveDirNameMirror`）。
 * @param key 同步源标识
 * @param handle 已授权的目录句柄
 */
export async function saveHandleToIndexedDB(
  key: SyncSourceKey,
  handle: SyncDirectoryHandle,
): Promise<void> {
  await requestPersistentStorage();
  const db = await openHandleDb();
  try {
    await putHandle(db, handleKey(key), handle);
  } finally {
    db.close();
  }
  saveDirNameMirror(key, handle.name);
}

/** 写入一个句柄记录 */
function putHandle(
  db: IDBDatabase,
  storeKey: string,
  handle: SyncDirectoryHandle,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).put(handle, storeKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('保存目录句柄失败'));
  });
}

/** 读取一个句柄记录 */
function getHandle(db: IDBDatabase, storeKey: string): Promise<SyncDirectoryHandle | null> {
  return new Promise<SyncDirectoryHandle | null>((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readonly');
    const req = tx.objectStore(STORE_HANDLES).get(storeKey);
    req.onsuccess = () => resolve((req.result as SyncDirectoryHandle | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error('读取目录句柄失败'));
  });
}

/** 删除一个句柄记录 */
function deleteHandle(db: IDBDatabase, storeKey: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_HANDLES, 'readwrite');
    tx.objectStore(STORE_HANDLES).delete(storeKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('清除目录句柄失败'));
  });
}

/**
 * 申请持久化存储（`navigator.storage.persist`）。
 *
 * 未申请持久化的站点，其 IndexedDB / localStorage 会被浏览器标记为「可回收」：
 * 在磁盘空间紧张或长时间未访问时，整个 `aidrivenote-sync` 库可能被删除，
 * 用户已绑定的本地文件夹就会「莫名其妙地不见了」。申请成功后浏览器会尽量不回收。
 *
 * 浏览器可能拒绝授予（无用户手势、权限策略限制），因此失败只记录不抛错——
 * 后续仍有 localStorage 目录名镜像作为兜底提示。
 * @returns 是否已处于持久化状态
 */
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persist) return false;
  try {
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

/**
 * 查询当前站点是否已获得持久化存储。
 * @returns 是否为持久化（持久化判断为 false 时浏览器仍可能回收 IndexedDB）
 */
export async function isPersistent(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.persisted) return false;
  try {
    return await navigator.storage.persisted();
  } catch {
    return false;
  }
}

/**
 * 把目录名镜像到 localStorage。
 *
 * 用途：即使 IndexedDB 里的句柄被浏览器回收，界面上仍能告诉用户
 * 「你之前绑定的是哪个文件夹」，避免直接显示成从未设置过的样子。
 * @param key 同步源标识
 * @param name 目录名；传空字符串表示清除镜像
 */
function saveDirNameMirror(key: SyncSourceKey, name: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (name) localStorage.setItem(`${NAME_MIRROR_PREFIX}${key}`, name);
    else localStorage.removeItem(`${NAME_MIRROR_PREFIX}${key}`);
  } catch {
    /* 隐私模式下写入可能失败，不影响主流程 */
  }
}

/**
 * 读取目录名镜像。
 * @param key 同步源标识
 * @returns 之前绑定的目录名；从未绑定或已清除时返回空字符串
 */
export function loadDirNameMirror(key: SyncSourceKey): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    const current = localStorage.getItem(`${NAME_MIRROR_PREFIX}${key}`);
    if (current) return current;
    // 旧版只有一个目录名镜像：仅在迁移目标正是该源时兜底
    if (localStorage.getItem(LEGACY_HANDLE_TARGET_KEY) === key) {
      return localStorage.getItem(LEGACY_NAME_MIRROR_KEY) ?? '';
    }
    return '';
  } catch {
    return '';
  }
}

/**
 * 从 IndexedDB 读取指定同步源的目录句柄。
 *
 * 首次读取时顺带完成旧版单根目录句柄的搬迁：旧配置迁移会写入
 * `LEGACY_HANDLE_TARGET_KEY` 标记，指明 `dir` 句柄应归到 notes 还是 kb。
 * @param key 同步源标识
 * @returns 目录句柄；从未授权或已失效时返回 null
 */
export async function loadHandleFromIndexedDB(
  key: SyncSourceKey,
): Promise<SyncDirectoryHandle | null> {
  if (typeof indexedDB === 'undefined') return null;
  try {
    const db = await openHandleDb();
    try {
      let handle = await getHandle(db, handleKey(key));
      if (!handle && shouldMigrateLegacy(key)) {
        const legacy = await getHandle(db, LEGACY_HANDLE_KEY);
        if (legacy) {
          await putHandle(db, handleKey(key), legacy);
          await deleteHandle(db, LEGACY_HANDLE_KEY);
          handle = legacy;
        }
        clearLegacyMigrationFlag();
      }
      if (handle) {
        // 数据还在：补写一次目录名镜像，并顺手申请持久化存储，
        // 防止浏览器因存储紧张把 aidrivenote-sync 整个回收掉
        saveDirNameMirror(key, handle.name);
        void requestPersistentStorage();
      }
      return handle;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 旧句柄是否应搬迁到当前同步源 */
function shouldMigrateLegacy(key: SyncSourceKey): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(LEGACY_HANDLE_TARGET_KEY) === key;
  } catch {
    return false;
  }
}

/** 清除旧句柄搬迁标记（无论是否找到旧句柄都只尝试一次） */
function clearLegacyMigrationFlag(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(LEGACY_HANDLE_TARGET_KEY);
  } catch {
    /* 忽略 */
  }
}

/**
 * 清除指定同步源在 IndexedDB 中保存的目录句柄（用户「断开文件夹」时调用）。
 * 同时清除目录名镜像，避免界面上残留已失效的目录名。
 * @param key 同步源标识
 */
export async function clearHandleFromIndexedDB(key: SyncSourceKey): Promise<void> {
  saveDirNameMirror(key, '');
  if (typeof indexedDB === 'undefined') return;
  try {
    const db = await openHandleDb();
    try {
      await deleteHandle(db, handleKey(key));
    } finally {
      db.close();
    }
  } catch {
    /* 清除失败不影响主流程 */
  }
}

/**
 * 查询目录是否仍持有读写权限。
 * @param handle 目录句柄
 * @returns 是否为 granted
 */
export async function queryPermission(handle: SyncDirectoryHandle): Promise<boolean> {
  if (typeof handle.queryPermission !== 'function') return true;
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 申请目录的读写权限。
 * ⚠️ 浏览器要求必须由用户手势（点击事件）触发，不能在页面加载时静默调用，
 * 因此本函数只应由 UI 的点击回调调用。
 * @param handle 目录句柄
 * @returns 是否已获得授权
 */
export async function requestPermission(handle: SyncDirectoryHandle): Promise<boolean> {
  if (typeof handle.requestPermission !== 'function') return true;
  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 确保已获得读写权限（先查询，未授权时按需申请）。
 * @param handle 目录句柄
 * @param opts.requestInGesture 是否允许在用户手势中触发授权弹窗
 * @returns 是否已获得授权
 */
export async function ensurePermission(
  handle: SyncDirectoryHandle,
  opts: { requestInGesture?: boolean } = {},
): Promise<boolean> {
  if (await queryPermission(handle)) return true;
  if (!opts.requestInGesture) return false;
  return requestPermission(handle);
}

/**
 * 拆分相对路径为「逐级目录数组 + 文件名」。
 * @param relPath 形如 `工作/周报.md` 的相对路径
 * @returns 目录片段数组与文件名
 */
function splitPath(relPath: string): { dirs: string[]; name: string } {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  const name = parts.pop() ?? '';
  return { dirs: parts, name };
}

/**
 * 拆分「目录」相对路径为逐级目录名数组。
 * 与 `splitPath` 的关键区别：目录路径的每一段都是目录，不能把最后一段当文件名丢掉，
 * 否则 `ensureDir(root, 'AI')` 会退化成根目录、子目录永远建不出来。
 * @param relDir 形如 `工作/周报` 的相对目录路径
 * @returns 逐级目录名数组
 */
function splitDirPath(relDir: string): string[] {
  return relDir.replace(/\\/g, '/').split('/').filter(Boolean);
}

/**
 * 逐级取得（可选创建）子目录句柄。
 * @param root 根目录句柄
 * @param dirs 逐级目录名
 * @param create 不存在时是否创建
 * @returns 目标目录句柄；create=false 且不存在时返回 null
 */
async function resolveDir(
  root: SyncDirectoryHandle,
  dirs: string[],
  create: boolean,
): Promise<SyncDirectoryHandle | null> {
  let current = root;
  for (const name of dirs) {
    try {
      current = (await current.getDirectoryHandle(name, { create })) as SyncDirectoryHandle;
    } catch (err) {
      if (!create && isNotFoundError(err)) return null;
      throw err;
    }
  }
  return current;
}

/**
 * 确保相对路径对应的目录存在（逐级创建）。
 * @param root 根目录句柄
 * @param relDir 相对目录路径，空字符串表示根目录
 * @returns 目标目录句柄
 */
export async function ensureDir(
  root: SyncDirectoryHandle,
  relDir: string,
): Promise<SyncDirectoryHandle> {
  const resolved = await resolveDir(root, splitDirPath(relDir), true);
  return resolved ?? root;
}

/**
 * 读取文件内容。
 * @param root 根目录句柄
 * @param relPath 相对文件路径
 * @returns 文件对象；路径不存在或指向目录时返回 null
 */
export async function readFile(
  root: SyncDirectoryHandle,
  relPath: string,
): Promise<File | null> {
  const { dirs, name } = splitPath(relPath);
  if (!name) return null;
  const dir = await resolveDir(root, dirs, false);
  if (!dir) return null;
  try {
    const handle = await dir.getFileHandle(name);
    return await handle.getFile();
  } catch (err) {
    if (isNotFoundError(err) || isTypeMismatchError(err)) return null;
    throw err;
  }
}

/**
 * 读取文本文件。
 * @param root 根目录句柄
 * @param relPath 相对文件路径
 * @returns 文本内容；文件不存在时返回 null
 */
export async function readTextFile(
  root: SyncDirectoryHandle,
  relPath: string,
): Promise<string | null> {
  const file = await readFile(root, relPath);
  if (!file) return null;
  return TEXT_DECODER.decode(await file.arrayBuffer());
}

/**
 * 写入文件（整文件覆盖，先截断后写入）。
 * 说明：File System Access API 没有真正的原子替换，「原子」指一次 createWritable 事务，
 * 写入失败时已存在的旧内容不会被部分覆盖。
 * @param root 根目录句柄
 * @param relPath 相对文件路径
 * @param data 写入内容
 */
export async function writeFileAtomic(
  root: SyncDirectoryHandle,
  relPath: string,
  data: Blob | string | ArrayBuffer,
): Promise<void> {
  const { dirs, name } = splitPath(relPath);
  if (!name) throw new Error(`非法的写入路径: ${relPath}`);
  const dir = await ensureDir(root, dirs.join('/'));
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
  } finally {
    await writable.close();
  }
}

/**
 * 列出目录下的直接子条目（文件与子目录）。
 * @param root 根目录句柄
 * @param relDir 相对目录路径，空字符串表示根目录
 * @returns 子条目列表；目录不存在时返回空数组
 */
export async function listDir(
  root: SyncDirectoryHandle,
  relDir = '',
): Promise<DirEntry[]> {
  const dir = await resolveDir(root, splitDirPath(relDir), false);
  if (!dir) return [];
  const entries: DirEntry[] = [];
  for await (const [name, handle] of dir.entries()) {
    entries.push({ name, kind: handle.kind });
  }
  return entries;
}

/** 遍历选项 */
export interface ListFilesOptions {
  /**
   * 目录级忽略谓词：命中则不进入该目录（相对起始目录的路径）。
   * 知识库模式下用它隔离 `raw/`、`templates/`、`archive/` 等目录。
   */
  ignoreDir?: (relDir: string) => boolean;
  /**
   * 文件级忽略谓词：命中则不收录（相对起始目录的路径）。
   * 知识库模式下用它隔离 `AGENTS.md`、`index.md`、`log.md` 等元文件。
   */
  ignoreFile?: (relPath: string) => boolean;
}

/**
 * 递归收集目录树下所有文件的相对路径（跳过 `.aidrivenote` 与其它点目录）。
 * 用于「已有 vault 的初始同步」场景判断哪些文件是外部文件（孤儿）。
 * @param root 根目录句柄
 * @param baseRel 起始相对目录路径
 * @param maxFiles 安全上限，防止超大目录把浏览器拖死
 * @param opts 忽略谓词（可选）
 * @returns 相对文件路径数组
 */
export async function listAllFiles(
  root: SyncDirectoryHandle,
  baseRel = '',
  maxFiles = 5000,
  opts: ListFilesOptions = {},
): Promise<string[]> {
  const out: string[] = [];

  /**
   * 递归内部实现。
   * @param dir 当前目录句柄
   * @param prefix 当前相对路径前缀
   */
  const walk = async (dir: SyncDirectoryHandle, prefix: string): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      if (out.length >= maxFiles) return;
      if (name.startsWith('.')) continue; // 跳过 .aidrivenote / .obsidian 等隐藏目录与文件
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'directory') {
        if (opts.ignoreDir?.(rel)) continue;
        await walk(handle as SyncDirectoryHandle, rel);
      } else {
        if (opts.ignoreFile?.(rel)) continue;
        out.push(rel);
      }
    }
  };

  const start = await resolveDir(root, splitDirPath(baseRel), false);
  if (!start) return out;
  await walk(start, '');
  return out;
}

/**
 * 把文件或目录移入回收站（先复制目标，再移除原位置）。
 * 这是本文件里唯一会调用 `removeEntry` 的地方，且只在回收站副本写入成功后执行，
 * 保证任何删除动作都是可逆的。
 * @param root 根目录句柄
 * @param relPath 待移入回收站的相对路径（文件或目录）
 * @param stamp 时间戳字符串，用于生成回收站内的唯一名（调用方传入以便同一批同步统一命名）
 * @returns 回收站内的相对路径；源不存在时返回 null
 */
export async function moveToTrash(
  root: SyncDirectoryHandle,
  relPath: string,
  stamp: string,
): Promise<string | null> {
  const { dirs, name } = splitPath(relPath);
  if (!name) return null;
  const parent = await resolveDir(root, dirs, false);
  if (!parent) return null;

  let source: FileSystemHandle;
  try {
    source = await parent.getFileHandle(name);
  } catch {
    try {
      source = await parent.getDirectoryHandle(name);
    } catch {
      return null; // 源不存在，无需处理
    }
  }

  const trashRel = await makeUniqueTrashPath(root, `${stamp}__${name}`);
  if (source.kind === 'file') {
    const file = await (source as FileSystemFileHandle).getFile();
    await writeFileAtomic(root, trashRel, file);
  } else {
    await copyDirectoryTo(root, source as SyncDirectoryHandle, trashRel);
  }

  // 副本落盘成功后才删除原位置，确保「删除」始终可逆
  await parent.removeEntry(name, { recursive: true });
  return trashRel;
}

/**
 * 生成不与既有条目冲突的回收站路径。
 * @param root 根目录句柄
 * @param baseName 期望的文件名
 * @returns 可用的相对路径
 */
async function makeUniqueTrashPath(
  root: SyncDirectoryHandle,
  baseName: string,
): Promise<string> {
  const base = `${APP_DIR}/${TRASH_DIR}`;
  const { name } = splitPath(baseName);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';

  // 用目录列举判断重名，可同时覆盖同名文件与同名目录
  const taken = new Set((await listDir(root, base)).map((e) => e.name));
  if (!taken.has(name)) return `${base}/${name}`;

  let index = 1;
  while (taken.has(`${stem}__${index}${ext}`)) index += 1;
  return `${base}/${stem}__${index}${ext}`;
}

/**
 * 递归复制目录内容到目标目录。
 * @param root 根目录句柄
 * @param source 源目录句柄
 * @param destRel 目标相对目录路径
 */
async function copyDirectoryTo(
  root: SyncDirectoryHandle,
  source: SyncDirectoryHandle,
  destRel: string,
): Promise<void> {
  await ensureDir(root, destRel);
  for await (const [name, handle] of source.entries()) {
    const childRel = `${destRel}/${name}`;
    if (handle.kind === 'directory') {
      await copyDirectoryTo(root, handle as SyncDirectoryHandle, childRel);
    } else {
      const file = await (handle as FileSystemFileHandle).getFile();
      await writeFileAtomic(root, childRel, file);
    }
  }
}