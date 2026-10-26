/**
 * 同步引擎 —— manifest 读写 + 三路比对 + 执行 + 报告。
 *
 * 设计要点：
 * - 三路比对（base / local / remote）：base 来自 manifest 记录的上次同步快照，
 *   local 来自本地文件 hash，remote 来自服务端 `updatedAt`；不依赖客户端时钟。
 * - 两端都改过同一条笔记时保留冲突副本，绝不覆盖用户数据。
 * - 删除一律走 `.aidrivenote/trash/` 或服务端软删除，全程可逆。
 * - 文件夹以服务端为权威：远端目录会落地到本地，本地新增目录会上报为服务端文件夹。
 *
 * 该文件同时承担「文件 ↔ 笔记」的双向转换：写方向复用 noteNativeExport 的路径规则，
 * 读方向手写 frontmatter 解析，不引入任何新依赖。
 *
 * ── 知识库模式（direction: 'kb'）─────────────────────────
 *
 * 给「本地 Markdown 知识库」当管理软件时启用。与通用镜像的语义差异：
 * - **路径即身份**：不依赖 frontmatter 里的笔记 ID，本地文件路径本身是映射键；
 * - **本地文件永不被删**：不调用 `moveToTrash`，也不调用 `noteApi.delete`；
 * - **本地文件永不被覆盖**：只有「本地未变」时才写回远端内容；
 * - **双改以本地为准**：远端变更记入报告，不生成冲突副本；
 * - **保护目录只导入**：`raw/`、`templates/` 永不写回；
 * - **不重命名本地文件**：远端标题变化不会让磁盘文件改名，避免产生重复笔记。
 */
import {
  noteApi,
  noteFolderApi,
  noteTagApi,
  type Note,
  type NoteFolder,
} from '../note';
import {
  buildFolderPath,
  getNativeExtension,
  isEmptyContent,
  sanitizeFileName,
} from '../../utils/noteNativeExport';
import { isIgnored, isProtected, type KbConfig } from './kbConfig';
import {
  APP_DIR,
  ensureDir,
  listAllFiles,
  moveToTrash,
  readFile,
  readTextFile,
  writeFileAtomic,
  type SyncDirectoryHandle,
} from './folderAccess';

/** 同步模式：compare 只出报告不写盘，apply 真正执行 */
export type SyncMode = 'compare' | 'apply';

/** 同步方向：two-way 通用镜像（默认），kb 知识库管理模式 */
export type SyncDirection = 'two-way' | 'kb';

/** 笔记类型 */
type NoteType = Note['noteType'];

/** manifest 中单条笔记的同步基线 */
export interface ManifestNoteEntry {
  /** 上次同步时的相对文件路径 */
  relPath: string;
  /** 笔记类型（决定文件扩展名与解析方式） */
  noteType: NoteType;
  /** 上次同步时的服务端 `updatedAt`（base 的远端侧） */
  serverUpdatedAt: string | null;
  /** 上次同步时的本地文件内容 hash（base 的本地侧） */
  contentHash: string;
  /** 上次同步时的本地文件修改时间，未变则跳过重算 hash */
  localMtime: number;
  /** 上次同步时的本地文件大小，与 mtime 一起构成变更判定 */
  localSize: number;
  /** 上次同步时的标题 */
  title: string;
  /** 上次同步时的相对目录路径（空字符串表示根目录） */
  folderPath: string;
  /** 上次同步时的标签 ID 列表 */
  tagIds: string[];
}

/** manifest 中单个文件夹的同步基线 */
export interface ManifestFolderEntry {
  /** 相对目录路径 */
  relPath: string;
  /** 上次同步时的服务端 `updatedAt` */
  serverUpdatedAt: string | null;
}

/** 同步状态清单（`.aidrivenote/sync.json` 的唯一数据结构） */
export interface Manifest {
  /** 结构版本号 */
  version: number;
  /** 绑定账号，防止不同账号复用同一文件夹 */
  userId: string;
  /** 上次同步完成时间 */
  lastSyncAt: string;
  /** 笔记基线，key 为笔记 ID */
  notes: Record<string, ManifestNoteEntry>;
  /** 文件夹基线，key 为文件夹 ID */
  folders: Record<string, ManifestFolderEntry>;
  /** 本地已存在但不属于本应用的文件（只报告，不处理） */
  orphans: string[];
}

/** 同步进度回调载荷 */
export interface SyncProgress {
  /** 当前阶段描述 */
  phase: string;
  /** 已完成数量 */
  done: number;
  /** 总数量（未知时为 0） */
  total: number;
}

/** 同步报告 */
export interface SyncReport {
  /** 本次运行模式 */
  mode: SyncMode;
  /** 下载（服务端 → 本地）条数 */
  downloaded: number;
  /** 上传（本地 → 服务端）条数 */
  uploaded: number;
  /** 冲突副本路径列表 */
  conflicts: string[];
  /** 因本地文件被删而软删除的服务端笔记标题列表 */
  localDeleted: string[];
  /** 因服务端删除而移入回收站的本地文件路径列表 */
  remoteDeleted: string[];
  /** 需要新建/已新建的本地目录路径列表 */
  createdFolders: string[];
  /** 移入回收站的本地目录路径列表 */
  removedFolders: string[];
  /** 需要新建/已新建的服务端文件夹路径列表 */
  uploadedFolders: string[];
  /** 判定为孤儿、未做任何处理的文件路径列表 */
  skippedOrphans: string[];
  /** 初始同步阶段检测到本地与远端不一致、但未写入的路径列表 */
  skippedLocalChanges: string[];
  /** 因加密/锁定而跳过的笔记条数（正文不下发，不参与本地同步） */
  skippedEncrypted: number;
  /** 是否处于 hash 降级模式（非安全上下文） */
  hashDegraded: boolean;
  /** 单条失败记录，不影响整体流程 */
  errors: { path: string; message: string }[];
  /** 总耗时（毫秒） */
  durationMs: number;
  // ── 知识库模式（direction: 'kb'）专属计数 ──
  /** 本次运行方向 */
  direction: SyncDirection;
  /** 由本地文件导入新建的笔记条数 */
  imported: number;
  /** 远端删除/移出范围、但本地文件已保留因而只解除映射的路径 */
  unlinkedLocal: string[];
  /** 本地文件消失、因而未删除服务端笔记的笔记标题 */
  missingLocal: string[];
  /** 双改时被本地覆盖的远端变更（本地为准，仅提示） */
  skippedRemoteChanges: string[];
  /** 因命中保护目录而拒绝写回 / 删除的路径 */
  blockedByProtection: string[];
  /** 因扩展名不受支持而跳过的文件条数 */
  skippedUnsupported: number;
}

/** 同步运行参数 */
export interface SyncOptions {
  /** 运行模式 */
  mode: SyncMode;
  /** 当前登录用户 ID，写入 manifest 用于账号绑定校验 */
  userId: string;
  /** 同步方向，默认 two-way（保持既有行为不变） */
  direction?: SyncDirection;
  /**
   * 知识库模式参数。`direction === 'kb'` 时必填。
   * 复用 KbConfig 的字段口径，避免两处定义漂移。
   */
  kb?: Pick<KbConfig, 'rootFolderId' | 'rootFolderName' | 'ignore' | 'protect'>;
  /** 进度回调 */
  onProgress?: (progress: SyncProgress) => void;
}

/** manifest 文件相对路径 */
export const MANIFEST_REL = `${APP_DIR}/sync.json`;
/** manifest 结构版本 */
const MANIFEST_VERSION = 1;
/** 远端分页拉取每页条数 */
const PAGE_SIZE = 200;
/** 冲突副本文件名特征（用于从孤儿扫描中排除），形如 `标题.conflict-20260930-221500.md` */
const CONFLICT_PATTERN = /\.conflict-\d{8}-\d{6}\./;

/** 知识库模式可导入的扩展名；其余（PDF / 图片等）只计数不读取，避免把大文件读进内存 */
const SUPPORTED_EXTENSIONS = ['.md', '.json', '.drawio'];

/** 本应用在所有权模式下写入的笔记 ID 键名（命名空间隔离，避免撞上外部工具的裸 `id`） */
const ADN_ID_KEY = 'adn_id';

/** 历史版本写入过的裸 `id` 键名，读取时继续兼容 */
const LEGACY_ID_KEY = 'id';

// ── 基础工具 ──────────────────────────────────────────

/**
 * 取相对路径的目录部分。
 * @param relPath 相对路径
 * @returns 相对目录路径（无目录时为空字符串）
 */
function dirname(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index >= 0 ? relPath.slice(0, index) : '';
}

/**
 * 取相对路径的文件名部分。
 * @param relPath 相对路径
 * @returns 文件名
 */
function basename(relPath: string): string {
  const index = relPath.lastIndexOf('/');
  return index >= 0 ? relPath.slice(index + 1) : relPath;
}

/**
 * 去掉文件名扩展名。
 * @param fileName 文件名
 * @returns 主干名
 */
function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

/**
 * 判断文件是否属于可导入的文本类型。
 * @param relPath 相对路径
 * @returns 是否支持导入
 */
function hasSupportedExtension(relPath: string): boolean {
  const name = basename(relPath).toLowerCase();
  return SUPPORTED_EXTENSIONS.some((ext) => name.endsWith(ext));
}

/**
 * 把「账号根视角」的目录路径裁剪为「知识库根视角」的相对路径。
 * @param fullPath 账号根视角的目录路径（空字符串表示账号根目录）
 * @param rootPath 知识库根的目录路径；空字符串表示不裁剪（全量同步）
 * @returns 相对路径；不在知识库子树内时返回 null
 */
function toScopedPath(fullPath: string, rootPath: string): string | null {
  if (!rootPath) return fullPath;
  if (fullPath === rootPath) return '';
  if (fullPath.startsWith(`${rootPath}/`)) return fullPath.slice(rootPath.length + 1);
  return null;
}

/**
 * 生成用于冲突副本与回收站命名的本地时间戳。
 * @returns 形如 `20260930-221500` 的字符串
 */
function localStamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/**
 * 判断当前是否需要 hash 降级（非安全上下文下 `crypto.subtle` 不可用）。
 * @returns 是否降级
 */
export function isHashDegraded(): boolean {
  if (typeof window === 'undefined') return true;
  return !window.isSecureContext || !crypto?.subtle;
}

/**
 * 计算字节内容的 SHA-256 十六进制摘要。
 * @param buffer 字节内容
 * @returns 十六进制摘要字符串
 */
async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 计算本地文件的内容签名。
 * 安全上下文下为 SHA-256；否则降级为「大小 + 修改时间」。
 * @param file 本地文件
 * @returns 签名 hash
 */
async function fileSignature(file: File): Promise<string> {
  if (isHashDegraded()) return `legacy:${file.size}:${file.lastModified}`;
  return sha256Hex(await file.arrayBuffer());
}

// ── manifest 读写 ─────────────────────────────────────

/**
 * 创建空的 manifest。
 * @param userId 当前用户 ID
 * @returns 初始 manifest
 */
function createEmptyManifest(userId: string): Manifest {
  return {
    version: MANIFEST_VERSION,
    userId,
    lastSyncAt: '',
    notes: {},
    folders: {},
    orphans: [],
  };
}

/**
 * 读取 manifest。
 * @param root 根目录句柄
 * @returns manifest；不存在或解析失败时返回 null
 */
export async function loadManifest(root: SyncDirectoryHandle): Promise<Manifest | null> {
  const text = await readTextFile(root, MANIFEST_REL);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Manifest;
    if (!parsed || typeof parsed !== 'object' || !parsed.notes) return null;
    return {
      version: parsed.version ?? MANIFEST_VERSION,
      userId: String(parsed.userId ?? ''),
      lastSyncAt: String(parsed.lastSyncAt ?? ''),
      notes: parsed.notes ?? {},
      folders: parsed.folders ?? {},
      orphans: Array.isArray(parsed.orphans) ? parsed.orphans : [],
    };
  } catch {
    return null;
  }
}

/**
 * 写入 manifest。
 * @param root 根目录句柄
 * @param manifest 待写入的 manifest
 */
export async function saveManifest(
  root: SyncDirectoryHandle,
  manifest: Manifest,
): Promise<void> {
  await writeFileAtomic(root, MANIFEST_REL, JSON.stringify(manifest, null, 2));
}

// ── 远端数据拉取 ───────────────────────────────────────

/**
 * 循环分页拉取全部未删除笔记（含正文）。
 * @returns 全部笔记
 */
async function fetchAllNotes(): Promise<Note[]> {
  const all: Note[] = [];
  let skip = 0;
  let total = Number.POSITIVE_INFINITY;
  while (skip < total) {
    const res = await noteApi.list({ skip, limit: PAGE_SIZE, includeContent: true });
    all.push(...res.items);
    total = res.total;
    if (res.items.length === 0) break;
    skip += PAGE_SIZE;
  }
  return all;
}

/**
 * 判断一条服务端笔记是否受加密保护（自身加密，或受加密祖先文件夹保护）。
 * 列表接口不携带解锁票据，加密笔记的正文恒为 null，
 * 因此绝不允许其参与「写入本地文件」的同步流程，避免产生空文件或明文落盘。
 * @param note 服务端笔记
 * @returns 是否受保护
 */
function isProtectedNote(note: Note): boolean {
  return Boolean(note.isEncrypted || note.isLocked || note.lockedScope);
}

/**
 * 计算每个远端笔记对应的相对文件路径。
 * 复用 `notesToNativeFiles` 的路径规则（非法字符处理、重名加 `__noteNo` 后缀），
 * 并按 `noteNo` 排序保证多次运行的路径稳定。
 * @param notes 远端笔记
 * @param folders 远端文件夹
 * @param rootPath 知识库根路径；非空时只保留该子树内的笔记，且路径相对知识库根计算
 * @returns 笔记 ID → 相对路径
 */
function computeRemotePaths(
  notes: Note[],
  folders: NoteFolder[],
  rootPath = '',
): Map<string, string> {
  const sorted = [...notes].sort((a, b) => (a.noteNo < b.noteNo ? -1 : 1));
  const used = new Set<string>();
  const map = new Map<string, string>();

  for (const note of sorted) {
    // 加密/锁定笔记不参与本地同步：既不下发正文，也不写入本地文件
    if (isProtectedNote(note)) continue;
    if (isEmptyContent(note.noteType, note.content)) continue;
    const folderPath = toScopedPath(buildFolderPath(note.folderId, folders), rootPath);
    if (folderPath === null) continue;
    const ext = getNativeExtension(note.noteType);
    const baseName = sanitizeFileName(note.title || '无标题');
    let rel = folderPath ? `${folderPath}/${baseName}${ext}` : `${baseName}${ext}`;
    if (used.has(rel)) {
      const alt = `${baseName}__${note.noteNo}${ext}`;
      rel = folderPath ? `${folderPath}/${alt}` : alt;
    }
    used.add(rel);
    map.set(note.id, rel);
  }
  return map;
}

/**
 * 构建文件夹 ID ↔ 相对路径的双向映射。
 * @param folders 远端文件夹
 * @param rootPath 知识库根路径；非空时只保留该子树内的文件夹
 * @returns 双向映射
 */
function computeFolderMaps(
  folders: NoteFolder[],
  rootPath = '',
): {
  pathById: Map<string, string>;
  idByPath: Map<string, string>;
} {
  const pathById = new Map<string, string>();
  const idByPath = new Map<string, string>();
  for (const folder of folders) {
    const path = toScopedPath(buildFolderPath(folder.id, folders), rootPath);
    if (path === null) continue;
    pathById.set(folder.id, path);
    if (path) idByPath.set(path, folder.id);
  }
  return { pathById, idByPath };
}

// ── 文件 ↔ 笔记 双向转换 ────────────────────────────────

/** 解析出的本地文件内容 */
interface ParsedLocalFile {
  /** frontmatter 中的笔记 ID（`adn_id`，兼容历史 `id`；仅 `.md` 可能有） */
  metaId?: string;
  /** frontmatter 中的标题（仅 `.md` 可能有） */
  title?: string;
  /** frontmatter 中的标签名列表（仅 `.md` 可能有） */
  tagNames?: string[];
  /** 完整 frontmatter 解析结果：保留未知键、注释与顺序，写回时原样回填 */
  frontmatter?: FrontmatterResult;
  /** 由文件结构判定出的笔记类型 */
  noteType: NoteType;
  /** 笔记正文内容对象 */
  content: Record<string, unknown>;
}

/**
 * 把值压成单行（frontmatter 不支持多行值，方括号会破坏 tags 数组语法）。
 * @param value 原始值
 * @returns 单行文本
 */
function oneLine(value: string): string {
  return (value ?? '').replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '');
}

/** 写回笔记文件时的可选项 */
interface SerializeOptions {
  /**
   * 已存在文件的 frontmatter 解析结果。
   * 传入后：未知键、注释与键顺序**原样保留**，只有本应用负责的键被替换。
   * 不传（新建文件）时按标准顺序生成。
   *
   * ⚠️ 比对与写回必须传**同一个** preserve，否则两侧产出不一致会造成反复上传。
   */
  preserve?: FrontmatterResult | null;
  /**
   * 笔记 ID 的键名。`null` 表示不写 ID（知识库模式：映射由 manifest 承担，
   * 写进知识页反而会污染其 frontmatter 规范）。
   */
  idKey?: string | null;
  /**
   * 是否写入 `folder` / `updated_at` 等本应用专有键，默认 true。
   * 知识库模式传 false —— 文件所在目录本身已表达层级，写进 frontmatter 只会污染知识页。
   */
  writeAppKeys?: boolean;
}

/**
 * 生成笔记文件的文本内容（`.md` 会在正文前拼接 YAML frontmatter）。
 * @param note 远端笔记
 * @param relPath 目标相对路径
 * @param tagNames 标签名列表（写入 frontmatter）
 * @param opts 写回选项
 * @returns 文件文本
 */
function serializeNoteText(
  note: Note,
  relPath: string,
  tagNames: string[],
  opts: SerializeOptions = {},
): string {
  const content = note.content ?? {};
  const ext = getNativeExtension(note.noteType);

  if (ext === '.md') {
    const text = typeof content.text === 'string' ? content.text : '';
    const folderPath = dirname(relPath);
    const writeAppKeys = opts.writeAppKeys !== false;

    // 本应用负责的键（写入时替换，其余一律原样保留）
    const managed = new Map<string, string>();
    if (opts.idKey) managed.set(opts.idKey, note.id);
    managed.set('title', oneLine(note.title));
    managed.set('tags', `[${tagNames.map((t) => oneLine(t).replace(/,/g, '')).join(', ')}]`);
    if (writeAppKeys) {
      if (folderPath) managed.set('folder', folderPath);
      if (note.updatedAt) managed.set('updated_at', note.updatedAt);
    }

    const header: string[] = [];
    const emitted = new Set<string>();
    for (const entry of opts.preserve?.entries ?? []) {
      const replacement = managed.get(entry.key);
      if (replacement !== undefined) {
        header.push(`${entry.key}: ${replacement}`);
        emitted.add(entry.key);
      } else {
        header.push(entry.raw);
      }
    }
    for (const [key, value] of managed) {
      if (!emitted.has(key)) header.push(`${key}: ${value}`);
    }

    return ['---', ...header, '---', '', text].join('\n');
  }

  if (ext === '.drawio') {
    return typeof content.xml === 'string' ? content.xml : '';
  }

  return JSON.stringify(content, null, 2);
}

/** frontmatter 中的一行（保序） */
interface FrontmatterLine {
  /** 键名 */
  key: string;
  /** 原始整行文本（保留缩进与行内注释） */
  raw: string;
  /** 冒号右侧的去空白值 */
  value: string;
}

/** frontmatter 解析结果 */
interface FrontmatterResult {
  /** 保序的原始行列表 */
  entries: FrontmatterLine[];
  /** 键值对（值均为字符串，`tags` 不在此列） */
  data: Record<string, string>;
  /** 标签名数组 */
  tags: string[];
  /** 去掉 frontmatter 后的正文 */
  body: string;
  /** 文件是否真的带 frontmatter 块 */
  present: boolean;
}

/** 空 frontmatter 结果 */
const EMPTY_FRONTMATTER: FrontmatterResult = {
  entries: [],
  data: {},
  tags: [],
  body: '',
  present: false,
};

/**
 * 手写 YAML frontmatter 解析器（只支持 `key: value` 与 `tags: [a, b]` 两种形态）。
 *
 * 与旧实现的差别：**保序**返回每一行原始文本，未知键不再被丢弃——
 * 这是知识库页 `type` / `sources` / `related` / `confidence` 不被抹掉的前提。
 * @param text 文件全文
 * @returns 解析结果；无 frontmatter 时 entries 为空且 body 为原文
 */
function parseFrontmatter(text: string): FrontmatterResult {
  if (!text.startsWith('---')) {
    return { ...EMPTY_FRONTMATTER, body: text };
  }
  const end = text.indexOf('\n---', 3);
  if (end < 0) {
    return { ...EMPTY_FRONTMATTER, body: text };
  }

  const header = text.slice(text.indexOf('\n') + 1, end);
  const body = text.slice(text.indexOf('\n', end + 1) + 1);
  const entries: FrontmatterLine[] = [];
  const data: Record<string, string> = {};
  const tags: string[] = [];

  for (const rawLine of header.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    entries.push({ key, raw: rawLine, value });
    if (key === 'tags') {
      const inner = value.replace(/^\[/, '').replace(/\]$/, '');
      tags.push(...inner.split(',').map((t) => t.trim()).filter(Boolean));
    } else {
      data[key] = value;
    }
  }
  return { entries, data, tags, body, present: true };
}

/**
 * 由相对路径推断原生文件扩展名。
 * @param relPath 相对路径
 * @returns 扩展名（含点号）
 */
function getNativeExtensionFromPath(relPath: string): string {
  const name = basename(relPath).toLowerCase();
  if (name.endsWith('.md')) return '.md';
  if (name.endsWith('.drawio')) return '.drawio';
  return '.json';
}

/**
 * 解析本地文件为笔记内容。
 * `.md` → `{ text }`；`.drawio` → `{ xml }`；`.json` → 原对象（按结构判定 rich_text / mindmap）。
 * @param relPath 相对路径（用于判断扩展名）
 * @param text 文件文本
 * @returns 解析结果；结构非法时返回 null
 */
function parseLocalFile(relPath: string, text: string): ParsedLocalFile | null {
  const ext = getNativeExtensionFromPath(relPath);

  if (ext === '.md') {
    const fm = parseFrontmatter(text);
    return {
      metaId: fm.data[ADN_ID_KEY] || fm.data[LEGACY_ID_KEY] || undefined,
      title: fm.data.title || undefined,
      tagNames: fm.tags,
      frontmatter: fm,
      noteType: 'markdown',
      content: { text: fm.body },
    };
  }

  if (ext === '.drawio') {
    return { noteType: 'flowchart', content: { xml: text } };
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const noteType: NoteType =
      parsed.blocks !== undefined
        ? 'rich_text'
        : parsed.data !== undefined || parsed.children !== undefined
          ? 'mindmap'
          : 'rich_text';
    return { noteType, content: parsed };
  } catch {
    return null;
  }
}

// ── 知识库元数据映射 ───────────────────────────────────

/**
 * 由知识库 frontmatter 派生笔记标签：原有标签 + `type` / `topic` 前缀标签。
 *
 * 加前缀是为了避免撞上用户在笔记里已有的同名标签（`concept` 这类词太通用）。
 * @param fm frontmatter 解析结果
 * @param baseTags 原有标签
 * @returns 去重后的标签名列表
 */
function kbTagsFromFrontmatter(
  fm: FrontmatterResult | undefined,
  baseTags: string[],
): string[] {
  const out = [...baseTags];
  const type = fm?.data.type?.trim();
  if (type) out.push(`kb:${type}`);
  const topic = fm?.data.topic?.trim();
  if (topic) out.push(`topic:${topic}`);
  return [...new Set(out.filter((t) => t && t.trim() !== ''))];
}

/**
 * 知识库模式下**写回文件**时应使用的标签：剔除由 frontmatter 派生出来的前缀标签。
 *
 * `kb:` / `topic:` 是入库时从 `type` / `topic` 派生的检索用标签，
 * 若把它们写回文件会造成内容漂移（文件被改写 → 下次比对又判为变更）。
 * @param note 远端笔记
 * @returns 应写回文件的标签名列表
 */
function kbFileTags(note: Note): string[] {
  return (note.tags ?? [])
    .map((t) => t.name)
    .filter((name) => !name.startsWith('kb:') && !name.startsWith('topic:'));
}

/**
 * 由知识库 frontmatter 派生笔记描述，保存溯源信息。
 *
 * 为什么不注入正文：正文一旦被注入内容，就会与磁盘文件不一致，
 * 下次同步会被判定为「本地变更」并上传，形成来回震荡。
 * 描述不参与内容比对，因此安全。
 * @param fm frontmatter 解析结果
 * @returns 描述文本；无可映射字段时返回 undefined
 */
function kbDescriptionFromFrontmatter(fm: FrontmatterResult | undefined): string | undefined {
  if (!fm) return undefined;
  const parts: string[] = [];
  const confidence = fm.data.confidence?.trim();
  if (confidence) parts.push(`confidence: ${confidence}`);
  if (fm.data.sources) parts.push(`sources: ${oneLine(fm.data.sources)}`);
  if (fm.data.related) parts.push(`related: ${oneLine(fm.data.related)}`);
  return parts.length ? `[kb] ${parts.join(' | ')}`.slice(0, 500) : undefined;
}

// ── 计划结构 ──────────────────────────────────────────

/** 计划中的单个笔记动作 */
type SyncAction =
  | { kind: 'download'; noteId: string; note: Note; targetRel: string; oldRel?: string }
  | {
      kind: 'upload';
      noteId: string;
      relPath: string;
      file: File;
      text: string;
      parsed: ParsedLocalFile;
      remote: Note;
    }
  | {
      kind: 'conflict';
      noteId: string;
      conflictRel: string;
      targetRel: string;
      oldRel?: string;
      localText: string;
      remote: Note;
    }
  | { kind: 'remoteDelete'; noteId: string; relPath: string }
  | { kind: 'localDelete'; noteId: string; title: string }
  /** 知识库模式：把本地新文件导入为一条新笔记 */
  | { kind: 'import'; relPath: string; title: string; parsed: ParsedLocalFile };

/** 文件夹同步计划 */
interface FolderPlan {
  /** 远端有、需要创建的本地目录 */
  localDirsToCreate: string[];
  /** 远端已删除、需要移入回收站的本地目录 */
  localDirsToTrash: string[];
  /** 本地有、需要上报的服务端文件夹 */
  remoteDirsToCreate: string[];
}

// ── 主流程 ────────────────────────────────────────────

/**
 * 执行一次同步。
 * @param root 用户授权的根目录句柄
 * @param opts 运行参数
 * @returns 同步报告
 */
export async function runSync(
  root: SyncDirectoryHandle,
  opts: SyncOptions,
): Promise<SyncReport> {
  const startedAt = Date.now();
  const stamp = localStamp();
  const direction: SyncDirection = opts.direction ?? 'two-way';
  const isKb = direction === 'kb';
  const report: SyncReport = {
    mode: opts.mode,
    direction,
    downloaded: 0,
    uploaded: 0,
    conflicts: [],
    localDeleted: [],
    remoteDeleted: [],
    createdFolders: [],
    removedFolders: [],
    uploadedFolders: [],
    skippedOrphans: [],
    skippedLocalChanges: [],
    skippedEncrypted: 0,
    hashDegraded: isHashDegraded(),
    errors: [],
    durationMs: 0,
    imported: 0,
    unlinkedLocal: [],
    missingLocal: [],
    skippedRemoteChanges: [],
    blockedByProtection: [],
    skippedUnsupported: 0,
  };
  const progress = (phase: string, done = 0, total = 0) =>
    opts.onProgress?.({ phase, done, total });

  // 1. 读取 manifest
  progress('读取同步状态');
  const loaded = await loadManifest(root);
  const hadManifest = !!loaded && loaded.userId === opts.userId;
  if (loaded && !hadManifest) {
    report.errors.push({
      path: MANIFEST_REL,
      message: '该文件夹此前绑定其它账号，本次重建同步状态（不删除任何文件）',
    });
  }
  const manifest = hadManifest && loaded ? loaded : createEmptyManifest(opts.userId);
  const nextManifest: Manifest = {
    ...createEmptyManifest(opts.userId),
    lastSyncAt: manifest.lastSyncAt,
  };

  // 2. 拉取远端数据
  progress('拉取服务端数据');
  const [notes, folders, tags] = await Promise.all([
    fetchAllNotes(),
    noteFolderApi.list(),
    noteTagApi.list(),
  ]);
  const noteById = new Map(notes.map((n) => [n.id, n]));
  const tagNameToId = new Map(tags.map((t) => [t.name, t.id]));

  // 2.1 解析知识库作用域
  let rootPath = '';
  if (isKb) {
    if (!opts.kb?.rootFolderId) {
      report.errors.push({
        path: MANIFEST_REL,
        message: '知识库模式缺少根文件夹配置，本次未执行同步',
      });
      report.durationMs = Date.now() - startedAt;
      return report;
    }
    rootPath = buildFolderPath(opts.kb.rootFolderId, folders);
    if (!rootPath) {
      // 根文件夹被删除或改名：绝不能退化成「全量同步」，直接中止
      report.errors.push({
        path: opts.kb.rootFolderName || opts.kb.rootFolderId,
        message: '找不到知识库根文件夹（可能已被删除或改名），请重新指定后再同步',
      });
      report.durationMs = Date.now() - startedAt;
      return report;
    }
  }
  const protect = isKb ? (opts.kb?.protect ?? []) : [];

  // 加密/锁定笔记一律跳过本地同步，并在报告中计数（只统计落在本次范围内的）
  report.skippedEncrypted = notes.filter(
    (n) =>
      isProtectedNote(n) &&
      toScopedPath(buildFolderPath(n.folderId, folders), rootPath) !== null,
  ).length;
  const remotePaths = computeRemotePaths(notes, folders, rootPath);
  const folderMaps = computeFolderMaps(folders, rootPath);

  // 3. 扫描本地文件（知识库模式下应用忽略清单）
  progress('扫描本地文件');
  const ignore = isKb ? (opts.kb?.ignore ?? []) : [];
  const ignorePredicate = (rel: string) => isIgnored(rel, ignore);
  const allLocalFiles = await listAllFiles(root, '', 5000, {
    ignoreDir: ignorePredicate,
    ignoreFile: ignorePredicate,
  });

  const localFiles = new Map<string, File>();
  let skippedUnsupported = 0;
  for (const rel of allLocalFiles) {
    // 知识库模式下只读取文本类文件，避免把 PDF / 图片读进内存
    if (isKb && !hasSupportedExtension(rel)) {
      skippedUnsupported += 1;
      continue;
    }
    const file = await readFile(root, rel);
    if (file) localFiles.set(rel, file);
  }
  report.skippedUnsupported = skippedUnsupported;

  const manifestPaths = new Set(Object.values(manifest.notes).map((e) => e.relPath));
  const extraFiles = [...localFiles.keys()].filter(
    (rel) => !manifestPaths.has(rel) && !CONFLICT_PATTERN.test(basename(rel)),
  );

  /** 文本读取缓存：同一文件在比对与报告阶段只读一次 */
  const textCache = new Map<string, string>();
  const readText = async (rel: string): Promise<string | null> => {
    const cached = textCache.get(rel);
    if (cached !== undefined) return cached;
    const text = await readTextFile(root, rel);
    if (text !== null) textCache.set(rel, text);
    return text;
  };

  // 认领映射：仅 `.md` 能从 frontmatter 读到笔记 ID（通用镜像模式使用）
  const claimedByNoteId = new Map<string, { relPath: string; text: string }>();
  if (!isKb) {
    for (const rel of extraFiles) {
      try {
        const text = await readText(rel);
        if (text === null) continue;
        const id = parseLocalFile(rel, text)?.metaId;
        if (id && !claimedByNoteId.has(id)) claimedByNoteId.set(id, { relPath: rel, text });
      } catch (err) {
        report.errors.push({ path: rel, message: String(err) });
      }
    }
  }
  const claimedPaths = new Set([...claimedByNoteId.values()].map((c) => c.relPath));
  // 知识库模式下未认领的文件会被导入为笔记，不产生孤儿
  report.skippedOrphans = isKb ? [] : extraFiles.filter((rel) => !claimedPaths.has(rel));

  // 4. 三路比对，产出计划
  progress('比对差异');
  const actions: SyncAction[] = isKb
    ? await planKbActions({
        root,
        protect,
        hadManifest,
        noteById,
        remotePaths,
        localFiles,
        extraFiles,
        manifest,
        nextManifest,
        report,
        readText,
      })
    : [];
  // 知识库模式走独立分支，通用镜像循环在 KB 模式下不执行
  const noteIds = new Set<string>(
    isKb
      ? []
      : [...Object.keys(manifest.notes), ...notes.map((n) => n.id)],
  );

  /** 记录一条基线（仅更新 relPath / hash 等，不修改服务端） */
  const adopt = (
    noteId: string,
    note: Note,
    relPath: string,
    hash: string,
    file: File,
  ): void => {
    nextManifest.notes[noteId] = {
      relPath,
      noteType: note.noteType,
      serverUpdatedAt: note.updatedAt ?? null,
      contentHash: hash,
      localMtime: file.lastModified,
      localSize: file.size,
      title: note.title,
      folderPath: dirname(relPath),
      tagIds: (note.tags ?? []).map((t) => t.id),
    };
  };

  for (const noteId of noteIds) {
    const base = manifest.notes[noteId];
    const remote = noteById.get(noteId);
    const remoteRel = remotePaths.get(noteId);

    // 远端笔记已删除，或内容变空（不再产生文件）→ 本地文件进回收站
    if (base && (!remote || !remoteRel)) {
      actions.push({ kind: 'remoteDelete', noteId, relPath: base.relPath });
      continue;
    }
    if (!base && (!remote || !remoteRel)) continue;

    // 从未同步过但远端存在：初始同步，或 manifest 丢失后的恢复
    if (!base && remote && remoteRel) {
      const claimed = claimedByNoteId.get(noteId);
      const claimedFile = claimed ? localFiles.get(claimed.relPath) : undefined;
      if (!claimed || !claimedFile) {
        if (localFiles.has(remoteRel)) {
          // 目标位置已被本地其它文件占用：绝不覆盖，只报告，交由用户决定
          report.skippedLocalChanges.push(remoteRel);
          continue;
        }
        actions.push({ kind: 'download', noteId, note: remote, targetRel: remoteRel });
        continue;
      }
      // 比对用的序列化必须与写回时使用同一套 preserve，否则会反复判定为变更
      const parsed = parseLocalFile(claimed.relPath, claimed.text);
      const remoteText = serializeNoteText(
        remote,
        remoteRel,
        (remote.tags ?? []).map((t) => t.name),
        { idKey: ADN_ID_KEY, preserve: parsed?.frontmatter ?? null },
      );
      if (remoteText === claimed.text) {
        // 内容完全一致：仅补回基线，无需任何写入
        adopt(noteId, remote, claimed.relPath, await fileSignature(claimedFile), claimedFile);
        continue;
      }
      if (hadManifest && parsed) {
        actions.push({
          kind: 'upload',
          noteId,
          relPath: claimed.relPath,
          file: claimedFile,
          text: claimed.text,
          parsed,
          remote,
        });
      } else {
        // 初始同步：不写服务端，只报告本地与远端不一致
        report.skippedLocalChanges.push(claimed.relPath);
      }
      continue;
    }

    if (!base || !remote || !remoteRel) continue;

    // base 与 remote 均存在：判定两端是否各自变更
    const localFile = localFiles.get(base.relPath);
    const localMissing = !localFile;
    let localHash = base.contentHash;
    if (localFile) {
      const mtimeUnchanged =
        localFile.lastModified === base.localMtime && localFile.size === base.localSize;
      if (!mtimeUnchanged) localHash = await fileSignature(localFile);
    }
    const remoteChanged = base.serverUpdatedAt !== (remote.updatedAt ?? null);
    const localChanged = localMissing || localHash !== base.contentHash;
    const pathChanged = base.relPath !== remoteRel;

    if (localMissing && !remoteChanged) {
      const claimed = claimedByNoteId.get(noteId);
      const claimedFile = claimed ? localFiles.get(claimed.relPath) : undefined;
      if (claimed && claimedFile) {
        // 文件被移动/重命名：以新位置为准继续同步，避免误判为删除
        const hash = await fileSignature(claimedFile);
        if (hash === base.contentHash) {
          adopt(noteId, remote, claimed.relPath, hash, claimedFile);
          continue;
        }
        const parsed = parseLocalFile(claimed.relPath, claimed.text);
        if (parsed) {
          actions.push({
            kind: 'upload',
            noteId,
            relPath: claimed.relPath,
            file: claimedFile,
            text: claimed.text,
            parsed,
            remote,
          });
          continue;
        }
      }
      actions.push({ kind: 'localDelete', noteId, title: remote.title });
      continue;
    }
    if (localMissing) {
      // 本地被删但远端也改了：以远端为准恢复本地文件，不丢远端数据
      actions.push({ kind: 'download', noteId, note: remote, targetRel: remoteRel });
      continue;
    }
    if (remoteChanged && localChanged) {
      actions.push({
        kind: 'conflict',
        noteId,
        conflictRel: buildConflictPath(base.relPath, stamp),
        targetRel: remoteRel,
        oldRel: pathChanged ? base.relPath : undefined,
        localText: (await readTextFile(root, base.relPath)) ?? '',
        remote,
      });
      continue;
    }
    if (remoteChanged || pathChanged) {
      actions.push({
        kind: 'download',
        noteId,
        note: remote,
        targetRel: remoteRel,
        oldRel: pathChanged ? base.relPath : undefined,
      });
      continue;
    }
    if (localChanged && localFile) {
      const text = (await readTextFile(root, base.relPath)) ?? '';
      const parsed = parseLocalFile(base.relPath, text);
      if (!parsed) {
        report.errors.push({ path: base.relPath, message: '文件格式无法解析，已跳过' });
        continue;
      }
      actions.push({
        kind: 'upload',
        noteId,
        relPath: base.relPath,
        file: localFile,
        text,
        parsed,
        remote,
      });
      continue;
    }
    // 两端都没变：仅刷新基线
    nextManifest.notes[noteId] = base;
  }

  // 5. 文件夹计划（compare 模式也展示，但不执行）
  const folderPlan = planFolders({
    hadManifest,
    folders,
    folderMaps,
    localFiles,
    manifest,
    allowLocalDelete: !isKb,
  });
  report.createdFolders = folderPlan.localDirsToCreate;
  report.removedFolders = folderPlan.localDirsToTrash;
  report.uploadedFolders = folderPlan.remoteDirsToCreate;

  // 6. compare 模式到此为止：只汇总笔记动作，不写盘
  if (opts.mode === 'compare') {
    summarizeActions(report, actions);
    report.durationMs = Date.now() - startedAt;
    return report;
  }

  // 7. apply：先同步文件夹，再逐条执行笔记动作
  const ctx: ApplyContext = {
    nextManifest,
    tagNameToId,
    folderMaps,
    folders,
    stamp,
    report,
    direction,
    protect,
    kbRootId: opts.kb?.rootFolderId ?? undefined,
  };
  progress('同步文件夹');
  await executeFolderPlan(root, folderPlan, ctx);

  progress('同步笔记', 0, actions.length);
  let done = 0;
  for (const action of actions) {
    try {
      await applyNoteAction(root, action, ctx);
    } catch (err) {
      report.errors.push({ path: describeAction(action), message: String(err) });
    }
    done += 1;
    progress('同步笔记', done, actions.length);
  }

  // 8. 落盘 manifest
  nextManifest.orphans = report.skippedOrphans;
  nextManifest.lastSyncAt = new Date().toISOString();
  await saveManifest(root, nextManifest);

  report.durationMs = Date.now() - startedAt;
  return report;
}

/**
 * 知识库模式的三路比对 —— **路径即身份**，本地文件永不被删、永不被覆盖。
 *
 * 与通用镜像的差异：
 * - 不依赖 frontmatter 里的笔记 ID，映射键是本地文件相对路径（随 manifest 持久化）；
 * - 远端删除 / 移出范围 → 只解除映射，不删本地文件；
 * - 本地文件消失 → 只报告，不删服务端笔记；
 * - 双改 → 本地为准，不生成冲突副本；
 * - 远端标题变化 → 原地更新，不重命名本地文件（否则旧文件会被当成新文件重复导入）；
 * - 保护目录内的路径 → 拒绝写回，记入 `blockedByProtection`。
 * @param params 比对上下文
 * @returns 待执行动作列表
 */
async function planKbActions(params: {
  root: SyncDirectoryHandle;
  protect: string[];
  hadManifest: boolean;
  noteById: Map<string, Note>;
  remotePaths: Map<string, string>;
  localFiles: Map<string, File>;
  extraFiles: string[];
  manifest: Manifest;
  nextManifest: Manifest;
  report: SyncReport;
  readText: (rel: string) => Promise<string | null>;
}): Promise<SyncAction[]> {
  const {
    protect,
    hadManifest,
    noteById,
    remotePaths,
    localFiles,
    extraFiles,
    manifest,
    nextManifest,
    report,
    readText,
  } = params;

  const actions: SyncAction[] = [];
  const handledLocal = new Set<string>();

  /** 记录一条基线（只更新本地台账，不修改服务端） */
  const adopt = (noteId: string, note: Note, relPath: string, hash: string, file: File): void => {
    nextManifest.notes[noteId] = {
      relPath,
      noteType: note.noteType,
      serverUpdatedAt: note.updatedAt ?? null,
      contentHash: hash,
      localMtime: file.lastModified,
      localSize: file.size,
      title: note.title,
      folderPath: dirname(relPath),
      tagIds: (note.tags ?? []).map((t) => t.id),
    };
  };

  // 路径 → 远端笔记 ID：知识库模式的映射键
  const noteIdByPath = new Map<string, string>();
  for (const [noteId, rel] of remotePaths) {
    if (!noteIdByPath.has(rel)) noteIdByPath.set(rel, noteId);
  }

  // 内容 hash → 笔记 ID：用于识别「用户在访达里把文件改名/搬走后不应重复导入」
  const missingHashClaims = new Map<string, string>();

  // ── 1) 已有基线的笔记 ──
  for (const [noteId, base] of Object.entries(manifest.notes)) {
    const remote = noteById.get(noteId);
    const localFile = localFiles.get(base.relPath);

    if (!remote || remotePaths.get(noteId) === undefined) {
      // 远端笔记被删除或移出知识库范围：保留本地文件，只解除映射
      if (localFile) report.unlinkedLocal.push(base.relPath);
      continue;
    }
    if (!localFile) {
      // 本地文件消失：不删服务端笔记，并保留基线 ——
      // 否则下次会被当成「应用内新建的笔记」重新落盘，等于把用户删掉的文件变回来
      report.missingLocal.push(remote.title || base.relPath);
      nextManifest.notes[noteId] = base;
      if (base.contentHash && !missingHashClaims.has(base.contentHash)) {
        missingHashClaims.set(base.contentHash, noteId);
      }
      continue;
    }

    handledLocal.add(base.relPath);
    const mtimeUnchanged =
      localFile.lastModified === base.localMtime && localFile.size === base.localSize;
    const localHash = mtimeUnchanged ? base.contentHash : await fileSignature(localFile);
    const localChanged = localHash !== base.contentHash;
    const remoteChanged = base.serverUpdatedAt !== (remote.updatedAt ?? null);

    if (localChanged) {
      // 本地为准（含双改）。远端同时变更只会记入报告，绝不生成冲突副本
      if (remoteChanged) report.skippedRemoteChanges.push(base.relPath);
      if (!hadManifest) {
        report.skippedLocalChanges.push(base.relPath);
        continue;
      }
      const text = (await readText(base.relPath)) ?? '';
      const parsed = parseLocalFile(base.relPath, text);
      if (!parsed) {
        report.errors.push({ path: base.relPath, message: '文件格式无法解析，已跳过' });
        continue;
      }
      actions.push({
        kind: 'upload',
        noteId,
        relPath: base.relPath,
        file: localFile,
        text,
        parsed,
        remote,
      });
      continue;
    }

    // 本地未变 → 可以安全写回
    if (remoteChanged) {
      const targetRel = base.relPath; // 不重命名本地文件
      if (isProtected(targetRel, protect)) {
        report.blockedByProtection.push(targetRel);
        nextManifest.notes[noteId] = base;
        continue;
      }
      actions.push({ kind: 'download', noteId, note: remote, targetRel });
      continue;
    }
    nextManifest.notes[noteId] = base;
  }

  // ── 2) 无基线：本地文件认领或导入 ──
  for (const rel of extraFiles) {
    if (handledLocal.has(rel)) continue;
    const file = localFiles.get(rel);
    if (!file) continue;
    const text = await readText(rel);
    if (text === null) continue;
    const parsed = parseLocalFile(rel, text);
    if (!parsed) {
      report.errors.push({ path: rel, message: '文件格式无法解析，已跳过' });
      continue;
    }
    handledLocal.add(rel);
    const fileHash = await fileSignature(file);

    const hitNoteId = noteIdByPath.get(rel);
    if (hitNoteId) {
      // 路径命中已有远端笔记：内容一致则补回基线，否则以本地为准上传
      const remote = noteById.get(hitNoteId);
      if (!remote) continue;
      const remoteText = serializeNoteText(
        remote,
        rel,
        kbFileTags(remote),
        { idKey: null, writeAppKeys: false, preserve: parsed.frontmatter ?? null },
      );
      if (remoteText === text) {
        adopt(hitNoteId, remote, rel, fileHash, file);
        continue;
      }
      if (!hadManifest) {
        report.skippedLocalChanges.push(rel);
        continue;
      }
      actions.push({ kind: 'upload', noteId: hitNoteId, relPath: rel, file, text, parsed, remote });
      continue;
    }

    // 内容 hash 命中某个「本地文件已消失」的基线 → 判定为移动/重命名，认领而不是新建
    const movedNoteId = missingHashClaims.get(fileHash);
    if (movedNoteId) {
      const remote = noteById.get(movedNoteId);
      if (remote) {
        missingHashClaims.delete(fileHash);
        adopt(movedNoteId, remote, rel, fileHash, file);
        continue;
      }
    }

    // 真正的新文件 → 导入为新建笔记
    actions.push({
      kind: 'import',
      relPath: rel,
      title: parsed.title?.trim() || stripExtension(basename(rel)),
      parsed,
    });
  }

  // ── 3) 远端有、本地无、基线也没有：应用内新建的笔记 → 写入本地 ──
  if (hadManifest) {
    for (const [noteId, targetRel] of remotePaths) {
      if (manifest.notes[noteId]) continue;
      if (localFiles.has(targetRel)) continue;
      const remote = noteById.get(noteId);
      if (!remote) continue;
      if (isProtected(targetRel, protect)) {
        report.blockedByProtection.push(targetRel);
        continue;
      }
      actions.push({ kind: 'download', noteId, note: remote, targetRel });
    }
  }

  return actions;
}

/**
 * 把计划动作汇总为报告数字。
 * @param report 报告对象
 * @param actions 计划动作
 */
function summarizeActions(report: SyncReport, actions: SyncAction[]): void {
  for (const action of actions) {
    switch (action.kind) {
      case 'download':
        report.downloaded += 1;
        break;
      case 'upload':
        report.uploaded += 1;
        break;
      case 'conflict':
        report.conflicts.push(action.conflictRel);
        break;
      case 'remoteDelete':
        report.remoteDeleted.push(action.relPath);
        break;
      case 'localDelete':
        report.localDeleted.push(action.title);
        break;
      case 'import':
        report.imported += 1;
        break;
    }
  }
}

/**
 * 生成冲突副本的相对路径。
 * @param relPath 正式文件路径
 * @param stamp 时间戳
 * @returns 冲突副本路径
 */
function buildConflictPath(relPath: string, stamp: string): string {
  const name = basename(relPath);
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  const dir = dirname(relPath);
  const conflictName = `${stem}.conflict-${stamp}${ext}`;
  return dir ? `${dir}/${conflictName}` : conflictName;
}

/**
 * 生成动作的可读描述（用于错误报告）。
 * @param action 动作
 * @returns 描述文本
 */
function describeAction(action: SyncAction): string {
  switch (action.kind) {
    case 'download':
      return action.targetRel;
    case 'upload':
      return action.relPath;
    case 'import':
      return action.relPath;
    case 'conflict':
      return action.conflictRel;
    case 'remoteDelete':
      return action.relPath;
    case 'localDelete':
      return action.title;
  }
}

// ── 文件夹同步 ────────────────────────────────────────

/**
 * 计算文件夹同步计划。
 * @param params 计划输入
 * @returns 文件夹计划
 */
function planFolders(params: {
  hadManifest: boolean;
  folders: NoteFolder[];
  folderMaps: { pathById: Map<string, string>; idByPath: Map<string, string> };
  localFiles: Map<string, File>;
  manifest: Manifest;
  /** 是否允许把本地目录移入回收站；知识库模式传 false（本地目录永不删除） */
  allowLocalDelete: boolean;
}): FolderPlan {
  const { hadManifest, folders, folderMaps, localFiles, manifest, allowLocalDelete } = params;

  const localDirsToCreate: string[] = [];
  for (const folder of folders) {
    const relPath = folderMaps.pathById.get(folder.id) ?? '';
    if (relPath) localDirsToCreate.push(relPath);
  }

  const localDirsToTrash: string[] = [];
  if (allowLocalDelete) {
    for (const [folderId, entry] of Object.entries(manifest.folders)) {
      if (!folderMaps.pathById.has(folderId)) localDirsToTrash.push(entry.relPath);
    }
  }

  const remoteDirsToCreate: string[] = [];
  if (hadManifest) {
    const localDirs = new Set<string>();
    for (const rel of localFiles.keys()) {
      let dir = dirname(rel);
      while (dir) {
        localDirs.add(dir);
        dir = dirname(dir);
      }
    }
    for (const dir of [...localDirs].sort(
      (a, b) => a.split('/').length - b.split('/').length,
    )) {
      if (!folderMaps.idByPath.has(dir)) remoteDirsToCreate.push(dir);
    }
  }

  return { localDirsToCreate, localDirsToTrash, remoteDirsToCreate };
}

/**
 * 执行文件夹同步计划。
 * @param root 根目录句柄
 * @param plan 文件夹计划
 * @param ctx 执行上下文
 */
async function executeFolderPlan(
  root: SyncDirectoryHandle,
  plan: FolderPlan,
  ctx: ApplyContext,
): Promise<void> {
  for (const relPath of plan.localDirsToCreate) {
    await ensureDir(root, relPath);
    const folder = ctx.folders.find((f) => ctx.folderMaps.pathById.get(f.id) === relPath);
    if (folder) {
      ctx.nextManifest.folders[folder.id] = {
        relPath,
        serverUpdatedAt: folder.updatedAt ?? null,
      };
    }
  }

  for (const relPath of plan.localDirsToTrash) {
    // 只有在允许删除本地目录时才可能非空（知识库模式恒为空）
    if (ctx.direction === 'kb') continue;
    await moveToTrash(root, relPath, ctx.stamp);
  }

  for (const dir of plan.remoteDirsToCreate) {
    const parts = dir.split('/').filter(Boolean);
    const name = parts.pop() ?? '';
    if (!name) continue;
    const parentPath = parts.join('/');
    // 知识库模式下顶层目录挂在知识库根下
    const parentId = parentPath ? ctx.folderMaps.idByPath.get(parentPath) : ctx.kbRootId;
    if (parentPath && !parentId) continue; // 父目录尚未就绪，跳过
    const created = await noteFolderApi.create({ name, parentId });
    ctx.folderMaps.idByPath.set(dir, created.id);
    ctx.folderMaps.pathById.set(created.id, dir);
    ctx.nextManifest.folders[created.id] = {
      relPath: dir,
      serverUpdatedAt: created.updatedAt ?? null,
    };
  }
}

// ── 笔记动作执行 ──────────────────────────────────────

/** 执行动作所需的上下文 */
interface ApplyContext {
  /** 待写入 manifest */
  nextManifest: Manifest;
  /** 标签名 → ID */
  tagNameToId: Map<string, string>;
  /** 文件夹双向映射 */
  folderMaps: { pathById: Map<string, string>; idByPath: Map<string, string> };
  /** 远端全部文件夹 */
  folders: NoteFolder[];
  /** 本次运行的时间戳 */
  stamp: string;
  /** 同步报告 */
  report: SyncReport;
  /** 本次运行方向（决定删除与覆盖策略） */
  direction: SyncDirection;
  /** 保护目录清单（知识库模式生效） */
  protect: string[];
  /** 知识库根文件夹 ID：知识库根下的笔记归档到它 */
  kbRootId?: string;
}

/**
 * 执行单条笔记动作。
 * @param root 根目录句柄
 * @param action 动作
 * @param ctx 执行上下文
 */
async function applyNoteAction(
  root: SyncDirectoryHandle,
  action: SyncAction,
  ctx: ApplyContext,
): Promise<void> {
  const isKb = ctx.direction === 'kb';
  switch (action.kind) {
    case 'download':
      await writeNoteToLocal(root, action.note, action.targetRel, ctx, action.oldRel);
      ctx.report.downloaded += 1;
      return;
    case 'upload': {
      const updated = await uploadLocalNote(action, ctx);
      // 上传后按服务端规范化结果重写本地文件，保证下次比对判定为「未变更」
      await writeNoteToLocal(root, updated, action.relPath, ctx);
      ctx.report.uploaded += 1;
      return;
    }
    case 'import': {
      const created = await importLocalNote(action, ctx);
      await writeNoteToLocal(root, created, action.relPath, ctx);
      ctx.report.imported += 1;
      return;
    }
    case 'conflict':
      // 本地修改先另存为冲突副本，再用远端内容覆盖正式文件
      await writeFileAtomic(root, action.conflictRel, action.localText);
      ctx.report.conflicts.push(action.conflictRel);
      await writeNoteToLocal(root, action.remote, action.targetRel, ctx, action.oldRel);
      return;
    case 'remoteDelete': {
      // 知识库模式：绝不删除本地文件，只解除映射
      if (isKb) {
        ctx.report.unlinkedLocal.push(action.relPath);
        delete ctx.nextManifest.notes[action.noteId];
        return;
      }
      const trashed = await moveToTrash(root, action.relPath, ctx.stamp);
      if (trashed) ctx.report.remoteDeleted.push(action.relPath);
      delete ctx.nextManifest.notes[action.noteId];
      return;
    }
    case 'localDelete':
      // 知识库模式：绝不因本地文件消失而删除服务端笔记
      if (isKb) {
        ctx.report.missingLocal.push(action.title);
        delete ctx.nextManifest.notes[action.noteId];
        return;
      }
      await noteApi.delete(action.noteId);
      delete ctx.nextManifest.notes[action.noteId];
      ctx.report.localDeleted.push(action.title);
      return;
  }
}

/**
 * 把本地文件写入本地文件系统（含 frontmatter 保真），并回填同步基线。
 *
 * 保真规则：先用**已存在文件**的 frontmatter 做 preserve 写入，
 * 未知键、注释与顺序原样保留 —— 这是知识库页 `type` / `sources` / `related`
 * 等字段不被抹掉的关键。
 * @param root 根目录句柄
 * @param note 远端笔记
 * @param targetRel 目标相对路径
 * @param ctx 执行上下文
 * @param oldRel 需要迁移的旧路径（通用镜像下移入回收站；知识库模式不处理）
 */
async function writeNoteToLocal(
  root: SyncDirectoryHandle,
  note: Note,
  targetRel: string,
  ctx: ApplyContext,
  oldRel?: string,
): Promise<void> {
  const isKb = ctx.direction === 'kb';

  // 保护目录只导入：不写本地文件，但仍要记录基线，
  // 否则每次同步都会把同一个文件重复上传（本地才是真相）。
  if (isKb && isProtected(targetRel, ctx.protect)) {
    ctx.report.blockedByProtection.push(targetRel);
    const existing = await readFile(root, targetRel);
    if (existing) {
      ctx.nextManifest.notes[note.id] = {
        relPath: targetRel,
        noteType: note.noteType,
        serverUpdatedAt: note.updatedAt ?? null,
        contentHash: await fileSignature(existing),
        localMtime: existing.lastModified,
        localSize: existing.size,
        title: note.title,
        folderPath: dirname(targetRel),
        tagIds: (note.tags ?? []).map((t) => t.id),
      };
    }
    return;
  }

  const tagNames = isKb ? kbFileTags(note) : (note.tags ?? []).map((t) => t.name);

  // 读已有文件的 frontmatter 做保真写入
  const existing = await readTextFile(root, targetRel);
  const preserve = existing === null ? null : parseFrontmatter(existing);

  await writeFileAtomic(
    root,
    targetRel,
    serializeNoteText(note, targetRel, tagNames, {
      preserve,
      idKey: isKb ? null : ADN_ID_KEY,
      writeAppKeys: !isKb,
    }),
  );

  if (oldRel && oldRel !== targetRel && !isKb) {
    // 通用镜像：覆盖或重命名后，旧路径内容保留在回收站，绝不静默删除
    await moveToTrash(root, oldRel, ctx.stamp);
  }

  const file = await readFile(root, targetRel);
  ctx.nextManifest.notes[note.id] = {
    relPath: targetRel,
    noteType: note.noteType,
    serverUpdatedAt: note.updatedAt ?? null,
    contentHash: file ? await fileSignature(file) : '',
    localMtime: file?.lastModified ?? 0,
    localSize: file?.size ?? 0,
    title: note.title,
    folderPath: dirname(targetRel),
    tagIds: (note.tags ?? []).map((t) => t.id),
  };
}

/**
 * 知识库模式：把本地文件导入为一条新笔记。
 * @param action 导入动作
 * @param ctx 执行上下文
 * @returns 服务端返回的新笔记
 */
async function importLocalNote(
  action: Extract<SyncAction, { kind: 'import' }>,
  ctx: ApplyContext,
): Promise<Note> {
  const { parsed, relPath, title } = action;
  const folderPath = dirname(relPath);
  // 知识库根下的文件归档到根文件夹本身
  const folderId = folderPath
    ? await resolveFolderId(folderPath, ctx)
    : ctx.kbRootId;

  const created = await noteApi.create({
    title,
    noteType: parsed.noteType,
    content: parsed.content,
    folderId,
    description: kbDescriptionFromFrontmatter(parsed.frontmatter),
    status: 'Active',
  });

  // 标签：原有标签 + 从 type / topic 派生的检索标签
  const desired = kbTagsFromFrontmatter(parsed.frontmatter, parsed.tagNames ?? []);
  for (const name of desired) {
    let tagId = ctx.tagNameToId.get(name);
    if (!tagId) {
      const tag = await noteTagApi.create({ name });
      tagId = tag.id;
      ctx.tagNameToId.set(name, tagId);
    }
    await noteTagApi.addToNote(created.id, tagId);
  }

  return desired.length > 0 ? noteApi.get(created.id) : created;
}

/**
 * 把本地文件内容上传到服务端（含标题、正文、文件夹、标签差集）。
 * @param action 上传动作
 * @param ctx 执行上下文
 * @returns 服务端返回的最新笔记
 */
async function uploadLocalNote(
  action: Extract<SyncAction, { kind: 'upload' }>,
  ctx: ApplyContext,
): Promise<Note> {
  const { parsed, remote } = action;
  // 标题优先取 `.md` frontmatter，其次沿用服务端标题，避免文件名规范化导致误改名
  const title = parsed.title?.trim() || remote.title;
  // 文件夹以文件实际所在目录为准（支持用户在访达中移动文件）
  const folderPath = dirname(action.relPath);
  const folderId = folderPath
    ? await resolveFolderId(folderPath, ctx)
    : ctx.kbRootId;

  await noteApi.update(action.noteId, {
    title,
    content: parsed.content,
    folderId: folderId ?? undefined,
  });

  // 标签：`.md` 用 frontmatter 的标签名，其它格式沿用服务端既有标签
  if (parsed.tagNames) {
    const desired = new Set<string>();
    for (const name of parsed.tagNames) {
      let tagId = ctx.tagNameToId.get(name);
      if (!tagId) {
        const created = await noteTagApi.create({ name });
        tagId = created.id;
        ctx.tagNameToId.set(name, tagId);
      }
      desired.add(tagId);
    }
    const current = new Set((remote.tags ?? []).map((t) => t.id));
    for (const tagId of desired) {
      if (!current.has(tagId)) await noteTagApi.addToNote(action.noteId, tagId);
    }
    for (const tagId of current) {
      if (!desired.has(tagId)) await noteTagApi.removeFromNote(action.noteId, tagId);
    }
    // 标签变化会影响返回结构，重新取一次拿到完整笔记
    return noteApi.get(action.noteId);
  }

  return noteApi.get(action.noteId);
}

/**
 * 解析相对目录路径对应的服务端文件夹 ID，不存在时逐级创建。
 * @param folderPath 相对目录路径
 * @param ctx 执行上下文
 * @returns 文件夹 ID
 */
async function resolveFolderId(
  folderPath: string,
  ctx: ApplyContext,
): Promise<string | undefined> {
  const existing = ctx.folderMaps.idByPath.get(folderPath);
  if (existing) return existing;

  const parts = folderPath.split('/').filter(Boolean);
  // 知识库模式下顶层目录必须挂在知识库根下，不能挂到账号根
  let parentId: string | undefined = ctx.kbRootId;
  let currentPath = '';
  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const known = ctx.folderMaps.idByPath.get(currentPath);
    if (known) {
      parentId = known;
      continue;
    }
    const created = await noteFolderApi.create({ name: part, parentId });
    ctx.folderMaps.idByPath.set(currentPath, created.id);
    ctx.folderMaps.pathById.set(created.id, currentPath);
    ctx.nextManifest.folders[created.id] = {
      relPath: currentPath,
      serverUpdatedAt: created.updatedAt ?? null,
    };
    parentId = created.id;
  }
  return parentId;
}