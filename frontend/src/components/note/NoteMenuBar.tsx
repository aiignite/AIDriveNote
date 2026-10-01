/**
 * NoteMenuBar – 笔记编辑器统一顶部菜单栏
 *
 * 渲染「文件 / 编辑 / 插入 / 视图 / 格式 / 帮助」下拉菜单，菜单项由面板命令与
 * 编辑器注册命令合并而成（见 utils/noteCommands.ts）。
 * 支持子菜单、分隔线、禁用态、勾选态、危险项与快捷键提示。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import {
  resolveMenuItems,
  type NoteCommand,
  type NoteMenuGroup,
  type ResolvedNoteMenuItem,
} from '../../utils/noteCommands';

/** 单个菜单组及其命令字典 */
export interface NoteMenuEntry {
  group: NoteMenuGroup;
  commands: Record<string, NoteCommand>;
}

interface NoteMenuBarProps {
  /** 菜单组列表（已按展示顺序排列） */
  menus: NoteMenuEntry[];
  /** 暗色主题 */
  isDark?: boolean;
}

/** 单层菜单列表（支持子菜单） */
const MenuList: React.FC<{
  items: ResolvedNoteMenuItem[];
  isDark: boolean;
  onDone: () => void;
  depth?: number;
}> = ({ items, isDark, onDone, depth = 0 }) => {
  const [openSubKey, setOpenSubKey] = useState<string | null>(null);

  const itemBase = `w-full flex items-center gap-3 px-3 py-1.5 text-xs text-left transition-colors rounded-sm`;
  const itemEnabled = isDark ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-orange-50 text-gray-700';
  const itemDisabled = isDark ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 cursor-not-allowed';

  return (
    <div
      className={`py-1 rounded-lg border shadow-xl min-w-[200px] ${
        isDark ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}
    >
      {items.map(item => (
        <React.Fragment key={item.key}>
          {item.separatorBefore && depth === 0 && (
            <div className={`my-1 h-px ${isDark ? 'bg-gray-700' : 'bg-gray-100'}`} />
          )}
          <div className="relative">
            <button
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (item.children?.length) {
                  setOpenSubKey(prev => (prev === item.key ? null : item.key));
                  return;
                }
                item.execute();
                onDone();
              }}
              onMouseEnter={() => setOpenSubKey(item.children?.length ? item.key : null)}
              className={`${itemBase} ${item.disabled ? itemDisabled : itemEnabled} ${
                item.danger && !item.disabled ? 'text-red-500 dark:text-red-400' : ''
              }`}
            >
              <span className="w-3.5 shrink-0">
                {item.checked && <Check size={12} className="text-orange-500" />}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {item.children?.length ? (
                <span className="shrink-0 opacity-60">›</span>
              ) : item.shortcut ? (
                <span className={`shrink-0 text-[10px] tabular-nums ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                  {item.shortcut}
                </span>
              ) : null}
            </button>
            {item.children?.length && openSubKey === item.key && (
              <div className="absolute left-full top-0 -mt-1 ml-0.5 z-10">
                <MenuList items={item.children} isDark={isDark} onDone={onDone} depth={depth + 1} />
              </div>
            )}
          </div>
        </React.Fragment>
      ))}
    </div>
  );
};

const NoteMenuBar: React.FC<NoteMenuBarProps> = ({ menus, isDark = false }) => {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  // 每次打开菜单重新解析（isEnabled / isChecked 需要在打开时求值）
  const resolvedMenus = useMemo(
    () => menus.map(entry => ({
      group: entry.group,
      items: resolveMenuItems(entry.group.items, entry.commands, entry.group.id),
    })),
    // openIndex 变化时也重新求值，保证勾选态最新
    [menus, openIndex],
  );

  const close = useCallback(() => setOpenIndex(null), []);

  useEffect(() => {
    if (openIndex === null) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) close();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [openIndex, close]);

  if (menus.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5" ref={barRef}>
      {resolvedMenus.map((entry, index) => {
        const isEmpty = entry.items.length === 0;
        return (
          <div className="relative" key={entry.group.id}>
            <button
              type="button"
              disabled={isEmpty}
              onClick={() => setOpenIndex(prev => (prev === index ? null : index))}
              onMouseEnter={() => { if (openIndex !== null && !isEmpty) setOpenIndex(index); }}
              className={`px-2.5 py-1 text-xs rounded-md transition-colors ${
                openIndex === index
                  ? (isDark ? 'bg-gray-700 text-white' : 'bg-orange-50 text-orange-700')
                  : isEmpty
                    ? (isDark ? 'text-gray-600 cursor-not-allowed' : 'text-gray-300 cursor-not-allowed')
                    : (isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-100')
              }`}
            >
              {entry.group.label}
            </button>
            {openIndex === index && !isEmpty && (
              <div className="absolute left-0 top-full mt-1 z-40">
                <MenuList items={entry.items} isDark={isDark} onDone={close} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default NoteMenuBar;