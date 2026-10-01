/**
 * 笔记命令与菜单模型
 *
 * 统一描述「可执行命令」与「菜单结构」，让顶部菜单栏（NoteMenuBar）与命令面板
 * （NoteCommandPalette）共用同一份数据，避免出现两套实现。
 *
 * 设计约定：
 * - 编辑器把自己支持的操作用 NoteCommand 描述，并在 NoteMenuGroup 里引用命令 id；
 * - 面板把自身的命令（文件/帮助等）与编辑器命令合并后统一渲染；
 * - 快捷键统一用规范化字符串（'Mod+Shift+1'）存储，展示时按平台转成 '⌘⇧1' / 'Ctrl+Shift+1'。
 */

/** 菜单组标识（顺序即展示顺序） */
export type NoteMenuGroupId = 'file' | 'edit' | 'insert' | 'view' | 'format' | 'help';

/** 菜单组展示顺序 */
export const MENU_GROUP_ORDER: NoteMenuGroupId[] = ['file', 'edit', 'insert', 'view', 'format', 'help'];

/** 菜单组默认中文标签 */
export const MENU_GROUP_LABEL: Record<NoteMenuGroupId, string> = {
  file: '文件',
  edit: '编辑',
  insert: '插入',
  view: '视图',
  format: '格式',
  help: '帮助',
};

/**
 * 一条可执行命令（菜单项 / 命令面板共用）
 */
export interface NoteCommand {
  /** 命令唯一标识，如 'edit.undo'、'insert.table' */
  id: string;
  /** 展示标签（中文） */
  label: string;
  /** 规范化快捷键，如 'Mod+Shift+1'；仅用于匹配与提示展示 */
  shortcut?: string;
  /** 命令面板模糊搜索的补充关键词 */
  keywords?: string;
  /** 危险操作，菜单中渲染为红色 */
  danger?: boolean;
  /** 执行命令 */
  run: () => void | Promise<void>;
  /** 是否可用（打开菜单/命令面板时求值），返回 false 时置灰 */
  isEnabled?: () => boolean;
  /** 是否为勾选态（如「显示大纲」） */
  isChecked?: () => boolean;
}

/**
 * 菜单项：引用命令、或自带 onSelect、或展开子菜单
 */
export interface NoteMenuItem {
  /** 引用的命令 id；与 onSelect / children 三选一 */
  commandId?: string;
  /** 直接执行的自定义回调（不经过命令表） */
  onSelect?: () => void;
  /** 子菜单项 */
  children?: NoteMenuItem[];
  /** 该项之前插入分隔线 */
  separatorBefore?: boolean;
  /** 覆盖命令的展示标签 */
  labelOverride?: string;
}

/**
 * 一个下拉菜单组
 */
export interface NoteMenuGroup {
  /** 菜单组标识 */
  id: NoteMenuGroupId;
  /** 菜单组标签，缺省用 MENU_GROUP_LABEL */
  label?: string;
  /** 菜单项列表 */
  items: NoteMenuItem[];
}

/**
 * 编辑器向面板注册的内容
 */
export interface NoteEditorRegistry {
  /** 平铺命令，供命令面板搜索与菜单引用 */
  commands: NoteCommand[];
  /** 编辑器自带的菜单组 */
  groups: NoteMenuGroup[];
}

/** 大纲（目录）条目 */
export interface NoteOutlineItem {
  /** 稳定标识：富文本用 block id，Markdown 用标题序号字符串 */
  id: string;
  /** 标题层级 1-6 */
  level: number;
  /** 标题文本 */
  text: string;
}

/**
 * 编辑器上报的大纲状态（无大纲能力的编辑器上报 null）
 */
export interface NoteOutlineState {
  /** 大纲条目 */
  items: NoteOutlineItem[];
  /** 当前高亮的条目 id */
  activeId?: string;
  /** 点击条目时的回调 */
  onSelect: (id: string) => void;
}

/** 解析后的菜单项（标签/快捷键/可用性已求值，可直接渲染） */
export interface ResolvedNoteMenuItem {
  /** React key */
  key: string;
  /** 展示标签 */
  label: string;
  /** 展示用快捷键文本 */
  shortcut?: string;
  /** 危险项 */
  danger?: boolean;
  /** 禁用态 */
  disabled?: boolean;
  /** 勾选态 */
  checked?: boolean;
  /** 该项之前插入分隔线 */
  separatorBefore?: boolean;
  /** 子菜单 */
  children?: ResolvedNoteMenuItem[];
  /** 执行该菜单项 */
  execute: () => void;
}

/** 运行平台是否为 macOS（决定快捷键展示与 Mod 映射） */
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');

/**
 * 把规范化快捷键转换为当前平台的展示文本。
 * @param shortcut 规范化快捷键，如 'Mod+Shift+1'
 * @returns 展示文本，如 macOS 上的 '⌘⇧1'、其他平台的 'Ctrl+Shift+1'
 */
export function formatShortcut(shortcut?: string): string {
  if (!shortcut) return '';
  const parts = shortcut.split('+').map(part => {
    switch (part) {
      case 'Mod': return IS_MAC ? '⌘' : 'Ctrl';
      case 'Shift': return IS_MAC ? '⇧' : 'Shift';
      case 'Alt': return IS_MAC ? '⌥' : 'Alt';
      case 'Ctrl': return 'Ctrl';
      default: return part;
    }
  });
  return parts.join(IS_MAC ? '' : '+');
}

/**
 * 判断键盘事件是否命中给定快捷键。
 * 支持修饰键：Mod（macOS 上为 ⌘，其余平台为 Ctrl）、Shift、Alt、Ctrl。
 * @param e 键盘事件
 * @param shortcut 规范化快捷键，如 'Mod+K'
 * @returns 是否命中
 */
export function matchShortcut(e: KeyboardEvent, shortcut?: string): boolean {
  if (!shortcut) return false;
  const parts = shortcut.split('+');
  const key = (parts[parts.length - 1] || '').toLowerCase();
  if (!key) return false;

  const needMod = parts.includes('Mod');
  const needCtrl = parts.includes('Ctrl');
  const needShift = parts.includes('Shift');
  const needAlt = parts.includes('Alt');

  const mod = IS_MAC ? e.metaKey : e.ctrlKey;
  if (needMod !== mod) return false;
  if (needCtrl !== e.ctrlKey) return false;
  if (needShift !== e.shiftKey) return false;
  if (needAlt !== e.altKey) return false;

  // 数字键在按下 Shift 时 e.key 会变成 '!' 等符号，用 e.code 兜底
  const eKey = e.key.toLowerCase();
  if (eKey === key) return true;
  if (/^[0-9]$/.test(key)) {
    return e.code === `Digit${key}` || e.code === `Numpad${key}`;
  }
  return false;
}

/**
 * 合并多份命令表，后者覆盖前者同 id 的命令。
 * @param maps 命令表列表（优先级从低到高）
 * @returns 合并后的命令字典
 */
export function mergeCommandMaps(
  ...maps: Array<Record<string, NoteCommand> | undefined>
): Record<string, NoteCommand> {
  const merged: Record<string, NoteCommand> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [id, cmd] of Object.entries(map)) merged[id] = cmd;
  }
  return merged;
}

/**
 * 递归收集菜单组内引用的命令（含子菜单），用于命令面板聚合。
 * @param groups 菜单组列表
 * @param commandMap 命令字典
 * @returns 去重后的命令列表（按出现顺序）
 */
export function collectMenuCommands(
  groups: NoteMenuGroup[],
  commandMap: Record<string, NoteCommand>,
): NoteCommand[] {
  const seen = new Set<string>();
  const result: NoteCommand[] = [];

  const walk = (items: NoteMenuItem[] | undefined) => {
    if (!items) return;
    for (const item of items) {
      if (item.commandId && !seen.has(item.commandId)) {
        seen.add(item.commandId);
        const cmd = commandMap[item.commandId];
        if (cmd) result.push(cmd);
      }
      walk(item.children);
    }
  };

  for (const group of groups) walk(group.items);
  return result;
}

/**
 * 把菜单项解析为可直接渲染的结构（求值标签、快捷键、禁用/勾选态）。
 * @param items 菜单项列表
 * @param commandMap 命令字典
 * @param keyPrefix 生成 React key 的前缀
 * @returns 解析后的菜单项列表
 */
export function resolveMenuItems(
  items: NoteMenuItem[],
  commandMap: Record<string, NoteCommand>,
  keyPrefix = 'mi',
): ResolvedNoteMenuItem[] {
  const resolved: ResolvedNoteMenuItem[] = [];

  items.forEach((item, index) => {
    const key = `${keyPrefix}-${index}`;

    if (item.children && item.children.length > 0) {
      resolved.push({
        key,
        label: item.labelOverride ?? '更多',
        separatorBefore: item.separatorBefore,
        children: resolveMenuItems(item.children, commandMap, key),
        execute: () => {},
      });
      return;
    }

    if (item.commandId) {
      const cmd = commandMap[item.commandId];
      if (!cmd) return;
      resolved.push({
        key,
        label: item.labelOverride ?? cmd.label,
        shortcut: formatShortcut(cmd.shortcut),
        danger: cmd.danger,
        disabled: cmd.isEnabled ? !cmd.isEnabled() : false,
        checked: cmd.isChecked ? cmd.isChecked() : false,
        separatorBefore: item.separatorBefore,
        execute: () => { void cmd.run(); },
      });
      return;
    }

    if (item.onSelect) {
      resolved.push({
        key,
        label: item.labelOverride ?? '未命名',
        separatorBefore: item.separatorBefore,
        execute: item.onSelect,
      });
    }
  });

  return resolved;
}