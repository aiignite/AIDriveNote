/**
 * 本地同步配置 —— 客户端持久化（localStorage）。
 *
 * 为什么存客户端而不是数据库：
 * 本地目录授权（File System Access 句柄）本身就保存在本机 IndexedDB 里，
 * 「哪个笔记文件夹是哪个磁盘目录的映射」天然是 per-device 概念。
 * 放客户端可与本机绑定天然对齐，且不需要任何后端迁移。
 *
 * 两个同步源完全独立、各自管理：
 * - `notes`：整棵笔记树 ↔ 用户自选的本地文件夹（通用双向镜像，排除知识库子树）；
 * - `kb`：笔记树根级的「知识库」文件夹 ↔ 固定的本地知识库目录。
 * 目录句柄在 IndexedDB 中按源分键保存（见 folderAccess），互不影响。
 */

/** 同步源标识 */
export type SyncSourceKey = 'notes' | 'kb';

/** 单个同步源的配置 */
export interface SyncSourceConfig {
  /** 是否参与「一键同步」（设置页仍可手动对比 / 同步） */
  enabled: boolean;
  /** 本机目录名镜像；句柄被浏览器回收时用于提示用户之前绑的是哪个目录 */
  localDirName: string;
  /** 笔记树侧作用域根文件夹 ID；notes 源为 null 表示整棵树 */
  rootFolderId: string | null;
  /** 作用域根文件夹名，删除/改名时用于提示 */
  rootFolderName: string;
  /** 相对作用域根的忽略清单：不扫描、不导入、不进报告 */
  ignore: string[];
  /** 相对作用域根的保护目录：可导入，但禁止写回、删除、重命名 */
  protect: string[];
}

/** 全部同步源配置 */
export interface SyncConfig {
  /** 结构版本号 */
  version: 2;
  /** 笔记树镜像源 */
  notes: SyncSourceConfig;
  /** 知识库源 */
  kb: SyncSourceConfig;
}

/** 知识库预设忽略清单：规则层 / 索引与日志 / 归档与模板 */
export const KB_PRESET_IGNORE: string[] = [
  'AGENTS.md',
  'CLAUDE.md',
  'MEMORY.md',
  'README.md',
  'index.md',
  'log.md',
  'archive',
  'templates',
];

/** 知识库预设保护目录：对齐知识库 AGENTS.md 第 2 节权限表 */
export const KB_PRESET_PROTECT: string[] = ['raw', 'templates'];

/** 知识库根文件夹的固定名称（由后端创建并标记为系统文件夹） */
export const KB_ROOT_FOLDER_NAME = '知识库';

/** 新配置的 localStorage 键 */
const STORAGE_KEY = 'aidrivenote.sync.sources';

/** 旧版（单根目录）配置键，仅用于一次性迁移 */
const LEGACY_KEY = 'aidrivenote.sync.kb';

/**
 * 迁移标记：旧版 IndexedDB 句柄应归到哪个同步源。
 * 由配置迁移写入，folderAccess 首次读取时消费并完成句柄搬迁。
 */
export const LEGACY_HANDLE_TARGET_KEY = 'aidrivenote.sync.legacyHandleTarget';

/** 配置变更事件：让笔记树等其它组件即时刷新知识库根标记 */
export const SYNC_CONFIG_EVENT = 'aidrivenote:sync-config-changed';

/** 广播配置变更 */
function notifyChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(SYNC_CONFIG_EVENT));
  } catch {
    /* 忽略 */
  }
}

/** 生成默认笔记同步源（不启用、无作用域、不设规则） */
export function defaultNotesSource(): SyncSourceConfig {
  return {
    enabled: false,
    localDirName: '',
    rootFolderId: null,
    rootFolderName: '',
    ignore: [],
    protect: [],
  };
}

/** 生成默认知识库同步源（不启用，规则填入知识库预设） */
export function defaultKbSource(): SyncSourceConfig {
  return {
    enabled: false,
    localDirName: '',
    rootFolderId: null,
    rootFolderName: '',
    ignore: [...KB_PRESET_IGNORE],
    protect: [...KB_PRESET_PROTECT],
  };
}

/** 生成默认配置 */
export function defaultSyncConfig(): SyncConfig {
  return {
    version: 2,
    notes: defaultNotesSource(),
    kb: defaultKbSource(),
  };
}

/**
 * 规范化规则清单：去空白、统一斜杠、去尾斜杠、去重。
 *
 * 注意保留**首斜杠**：`/AGENTS.md` 表示只匹配知识库根目录下的该文件，
 * 而不带斜杠的 `AGENTS.md` 会匹配任意层级的同名文件。
 * @param list 原始清单
 * @param fallback 非法时的兜底清单
 * @returns 规范化后的清单
 */
function normalizeList(list: unknown, fallback: string[]): string[] {
  if (!Array.isArray(list)) return [...fallback];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const value = item
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/+$/, '');
    // 仅保留单个首斜杠（根锚定），其余空值丢弃
    const anchored = value.startsWith('/') ? `/${value.replace(/^\/+/, '')}` : value;
    if (anchored && anchored !== '/' && !out.includes(anchored)) out.push(anchored);
  }
  return out;
}

/**
 * 规范化单个同步源的配置。
 * @param raw 原始对象
 * @param fallback 默认值（决定规则清单的兜底）
 * @returns 规范化后的配置
 */
function normalizeSource(
  raw: Partial<SyncSourceConfig> | null | undefined,
  fallback: SyncSourceConfig,
): SyncSourceConfig {
  const value = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: value.enabled === true,
    localDirName: typeof value.localDirName === 'string' ? value.localDirName : '',
    rootFolderId:
      typeof value.rootFolderId === 'string' && value.rootFolderId ? value.rootFolderId : null,
    rootFolderName: typeof value.rootFolderName === 'string' ? value.rootFolderName : '',
    ignore: normalizeList(value.ignore, fallback.ignore),
    protect: normalizeList(value.protect, fallback.protect),
  };
}

/** 旧版配置结构 */
interface LegacyKbConfig {
  enabled?: boolean;
  rootFolderId?: string | null;
  rootFolderName?: string;
  ignore?: string[];
  protect?: string[];
}

/**
 * 把旧版「单一根目录 + 知识库模式开关」迁移为双源配置。
 *
 * 判定规则：旧配置启用了知识库模式且指定了根文件夹 → 归入 kb 源；
 * 其余情况归入 notes 源。旧目录句柄由 folderAccess 按迁移标记搬到对应源。
 * @param legacy 旧配置
 * @returns 迁移后的配置
 */
function migrateLegacy(legacy: LegacyKbConfig): SyncConfig {
  const config = defaultSyncConfig();
  const isKb = legacy.enabled === true && typeof legacy.rootFolderId === 'string' && !!legacy.rootFolderId;

  if (isKb) {
    config.kb = normalizeSource(
      {
        enabled: true,
        rootFolderId: legacy.rootFolderId,
        rootFolderName: legacy.rootFolderName,
        ignore: legacy.ignore,
        protect: legacy.protect,
      },
      defaultKbSource(),
    );
  } else {
    config.notes = {
      ...defaultNotesSource(),
      enabled: legacy.enabled === true,
    };
  }

  saveSyncConfig(config);
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(LEGACY_HANDLE_TARGET_KEY, isKb ? 'kb' : 'notes');
      // 只在新配置确实写入后移除旧键，避免隐私模式下写失败时丢配置
      if (localStorage.getItem(STORAGE_KEY)) localStorage.removeItem(LEGACY_KEY);
    } catch {
      /* 隐私模式下写入失败时，仅丢失句柄搬迁（用户重新选一次即可） */
    }
  }
  return config;
}

/**
 * 读取同步配置。
 * @returns 配置；未设置或解析失败时返回默认配置
 */
export function loadSyncConfig(): SyncConfig {
  if (typeof localStorage === 'undefined') return defaultSyncConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SyncConfig> | null;
      if (parsed && typeof parsed === 'object') {
        return {
          version: 2,
          notes: normalizeSource(parsed.notes, defaultNotesSource()),
          kb: normalizeSource(parsed.kb, defaultKbSource()),
        };
      }
    }

    const legacyRaw = localStorage.getItem(LEGACY_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw) as LegacyKbConfig | null;
      if (legacy && typeof legacy === 'object') return migrateLegacy(legacy);
    }
    return defaultSyncConfig();
  } catch {
    return defaultSyncConfig();
  }
}

/**
 * 保存同步配置。
 * @param config 待保存配置
 */
export function saveSyncConfig(config: SyncConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        notes: {
          ...config.notes,
          ignore: normalizeList(config.notes.ignore, []),
          protect: normalizeList(config.notes.protect, []),
        },
        kb: {
          ...config.kb,
          ignore: normalizeList(config.kb.ignore, KB_PRESET_IGNORE),
          protect: normalizeList(config.kb.protect, KB_PRESET_PROTECT),
        },
      }),
    );
    notifyChanged();
  } catch {
    /* 隐私模式下写入可能失败，不影响主流程 */
  }
}

/**
 * 判断相对路径是否命中规则清单。
 *
 * 匹配语义（三种写法）：
 * - `/AGENTS.md` —— 带首斜杠，**只匹配根目录**下的该路径（子树同理：`/raw/old`）；
 * - `archive/2025` —— 含斜杠，按相对路径前缀匹配该子树；
 * - `templates` —— 不含斜杠，匹配**任意层级**上的同名文件或目录。
 *
 * 点开头的项（`.git/`、`.obsidian/`、`.gitkeep`）由扫描层的既有规则跳过，不需要写进清单。
 * @param relPath 相对知识库根的路径
 * @param rules 规则清单
 * @returns 是否命中
 */
export function matchRules(relPath: string, rules: string[]): boolean {
  if (!rules || rules.length === 0) return false;
  const path = relPath.replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (!path) return false;
  const parts = path.split('/').filter(Boolean);

  for (const raw of rules) {
    const rule = (raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rule) continue;

    if (rule.startsWith('/')) {
      const anchored = rule.slice(1);
      if (!anchored) continue;
      if (path === anchored || path.startsWith(`${anchored}/`)) return true;
      continue;
    }
    if (rule.includes('/')) {
      // 相对路径前缀匹配：允许规则不带根前缀也能命中深层同名子树
      if (path === rule || path.startsWith(`${rule}/`)) return true;
      for (let i = 1; i < parts.length; i += 1) {
        const tail = parts.slice(i).join('/');
        if (tail === rule || tail.startsWith(`${rule}/`)) return true;
      }
      continue;
    }
    if (parts.includes(rule)) return true;
  }
  return false;
}

/**
 * 判断相对路径是否在忽略清单内。
 * @param relPath 相对作用域根的路径
 * @param ignore 忽略清单
 * @returns 是否忽略
 */
export function isIgnored(relPath: string, ignore: string[]): boolean {
  return matchRules(relPath, ignore);
}

/**
 * 判断相对路径是否在保护目录内。
 * @param relPath 相对作用域根的路径
 * @param protect 保护清单
 * @returns 是否受保护
 */
export function isProtected(relPath: string, protect: string[]): boolean {
  return matchRules(relPath, protect);
}
