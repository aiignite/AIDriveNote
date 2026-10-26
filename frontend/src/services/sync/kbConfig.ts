/**
 * 知识库管理模式配置 —— 客户端持久化（localStorage）。
 *
 * 为什么存客户端而不是数据库：
 * 本地目录授权（File System Access 句柄）本身就保存在本机 IndexedDB 里，
 * 「哪个笔记文件夹是哪个磁盘目录的映射」天然是 per-device 概念。
 * 放客户端可与本机绑定天然对齐，且不需要任何后端迁移。
 */

/** 知识库管理模式配置 */
export interface KbConfig {
  /** 是否启用知识库模式 */
  enabled: boolean;
  /** 笔记树中被指定为「知识库根」的文件夹 ID */
  rootFolderId: string | null;
  /** 知识库根文件夹名。该文件夹被删除时用于提示，避免静默失效 */
  rootFolderName: string;
  /** 相对知识库根的忽略清单：不扫描、不导入、不进报告 */
  ignore: string[];
  /** 相对知识库根的保护目录：可导入，但禁止写回、删除、重命名 */
  protect: string[];
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

/** localStorage 键 */
const STORAGE_KEY = 'aidrivenote.sync.kb';

/** 配置变更事件：让笔记树等其它组件即时刷新知识库根标记 */
export const KB_CONFIG_EVENT = 'aidrivenote:kb-config-changed';

/** 广播配置变更 */
function notifyChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new Event(KB_CONFIG_EVENT));
  } catch {
    /* 忽略 */
  }
}

/**
 * 生成默认配置（忽略与保护目录填入知识库预设）。
 * @returns 默认配置
 */
export function defaultKbConfig(): KbConfig {
  return {
    enabled: false,
    rootFolderId: null,
    rootFolderName: '',
    ignore: [...KB_PRESET_IGNORE],
    protect: [...KB_PRESET_PROTECT],
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
 * 读取知识库配置。
 * @returns 配置；未设置或解析失败时返回默认配置
 */
export function loadKbConfig(): KbConfig {
  if (typeof localStorage === 'undefined') return defaultKbConfig();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultKbConfig();
    const parsed = JSON.parse(raw) as Partial<KbConfig> | null;
    if (!parsed || typeof parsed !== 'object') return defaultKbConfig();
    return {
      enabled: parsed.enabled === true,
      rootFolderId: typeof parsed.rootFolderId === 'string' && parsed.rootFolderId
        ? parsed.rootFolderId
        : null,
      rootFolderName: typeof parsed.rootFolderName === 'string' ? parsed.rootFolderName : '',
      ignore: normalizeList(parsed.ignore, KB_PRESET_IGNORE),
      protect: normalizeList(parsed.protect, KB_PRESET_PROTECT),
    };
  } catch {
    return defaultKbConfig();
  }
}

/**
 * 保存知识库配置。
 * @param config 待保存配置
 */
export function saveKbConfig(config: KbConfig): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        enabled: config.enabled,
        rootFolderId: config.rootFolderId,
        rootFolderName: config.rootFolderName,
        ignore: normalizeList(config.ignore, KB_PRESET_IGNORE),
        protect: normalizeList(config.protect, KB_PRESET_PROTECT),
      }),
    );
    notifyChanged();
  } catch {
    /* 隐私模式下写入可能失败，不影响主流程 */
  }
}

/** 清除知识库配置（恢复默认） */
export function clearKbConfig(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
    notifyChanged();
  } catch {
    /* 同上 */
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
 * @param relPath 相对知识库根的路径
 * @param ignore 忽略清单
 * @returns 是否忽略
 */
export function isIgnored(relPath: string, ignore: string[]): boolean {
  return matchRules(relPath, ignore);
}

/**
 * 判断相对路径是否在保护目录内。
 * @param relPath 相对知识库根的路径
 * @param protect 保护清单
 * @returns 是否受保护
 */
export function isProtected(relPath: string, protect: string[]): boolean {
  return matchRules(relPath, protect);
}
