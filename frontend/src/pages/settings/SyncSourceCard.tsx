/**
 * 单个同步源卡片：目录绑定、权限、规则、对比 / 同步与结果报告。
 *
 * 两个同步源共用同一套交互，但数据（句柄、配置、报告）完全独立。
 */
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Folder,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  Save,
  ShieldAlert,
  ShieldCheck,
  Unplug,
} from 'lucide-react';
import type { SyncSourceConfig, SyncSourceKey } from '../../services/sync/kbConfig';
import type { SyncSourceRuntime } from './useSyncSource';

interface SyncSourceCardProps {
  sourceKey: SyncSourceKey;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  accent: 'orange' | 'emerald';
  config: SyncSourceConfig;
  runtime: SyncSourceRuntime;
  isDark: boolean;
  supported: boolean;
  persistent: boolean | null;
  pickStartIn?: string;
  /** 固定目录提示，如 ~/Documents/KnowledgeBase/；固定目录不提供更换入口 */
  fixedPath?: string;
  /** 固定目录模式：只允许授权，不允许更换绑定 */
  lockDirectory?: boolean;
  /** 启动/停止「一键同步」 */
  onToggle: (enabled: boolean) => void;
  /** 保存忽略清单与保护目录 */
  onSaveRules: (ignore: string[], protect: string[]) => void;
  /** 恢复预设规则 */
  onResetPreset?: () => void;
  onCompare: () => void;
  onApply: () => void;
  /** 作用域说明（根文件夹状态、排除范围等） */
  scopeSlot?: React.ReactNode;
  /** 卡片底部附加内容 */
  children?: React.ReactNode;
}

const ACCENT = {
  orange: {
    icon: 'from-orange-500 to-orange-600 shadow-orange-500/20',
    button: 'bg-orange-600 hover:bg-orange-700',
    text: 'text-orange-600 dark:text-orange-400',
  },
  emerald: {
    icon: 'from-emerald-500 to-emerald-600 shadow-emerald-500/20',
    button: 'bg-emerald-600 hover:bg-emerald-700',
    text: 'text-emerald-600 dark:text-emerald-400',
  },
} as const;

/**
 * 同步源卡片。
 * @param props 卡片属性
 */
const SyncSourceCard: React.FC<SyncSourceCardProps> = ({
  sourceKey,
  title,
  subtitle,
  icon,
  accent,
  config,
  runtime,
  isDark,
  supported,
  persistent,
  pickStartIn,
  fixedPath,
  lockDirectory = false,
  onToggle,
  onSaveRules,
  onResetPreset,
  onCompare,
  onApply,
  scopeSlot,
  children,
}) => {
  const [ignoreDraft, setIgnoreDraft] = useState(() => config.ignore.join('\n'));
  const [protectDraft, setProtectDraft] = useState(() => config.protect.join('\n'));

  // 配置被外部恢复/迁移时同步草稿，避免文本框停留在旧值
  useEffect(() => {
    setIgnoreDraft(config.ignore.join('\n'));
    setProtectDraft(config.protect.join('\n'));
  }, [config.ignore, config.protect]);

  const card = 'bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm';
  const muted = isDark ? 'text-gray-400' : 'text-gray-500';
  const body = isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-gray-50';
  const input = isDark
    ? 'border-gray-700 bg-gray-800 text-gray-200'
    : 'border-gray-200 bg-white text-gray-800';
  const tones = ACCENT[accent];
  const { handle, granted, entries, busy, report, progress, error } = runtime;

  /** 保存规则：把多行文本拆成清单 */
  const saveRules = () => {
    const toList = (text: string) =>
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    onSaveRules(toList(ignoreDraft), toList(protectDraft));
  };

  return (
    <div className={card}>
      <div className="p-5 space-y-3">
        {/* 标题与绑定操作 */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${tones.icon} flex items-center justify-center shadow-lg`}>
              {icon}
            </div>
            <div>
              <h3 className={`text-base font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {title}
              </h3>
              <p className={`text-xs ${muted}`}>{subtitle}</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium cursor-pointer ${
              isDark ? 'border-gray-700 text-gray-200' : 'border-gray-200 text-gray-700'
            }`}>
              <input
                type="checkbox"
                checked={config.enabled}
                onChange={(e) => onToggle(e.target.checked)}
                className={accent === 'emerald' ? 'accent-emerald-600' : 'accent-orange-600'}
              />
              一键同步
            </label>
            {lockDirectory ? (
              handle && granted ? (
                <span
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium ${
                    isDark ? 'border-emerald-800 text-emerald-300' : 'border-emerald-300 text-emerald-700'
                  }`}
                >
                  <ShieldCheck size={14} /> 固定目录已授权
                </span>
              ) : handle ? (
                <button
                  type="button"
                  disabled={!supported}
                  onClick={() => void runtime.reauthorize()}
                  className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
                    isDark
                      ? 'border-amber-800 text-amber-300 hover:bg-amber-950/50'
                      : 'border-amber-300 text-amber-700 hover:bg-amber-50'
                  }`}
                >
                  <ShieldAlert size={15} /> 重新授权
                </button>
              ) : (
                <button
                  type="button"
                  disabled={!supported}
                  onClick={() => void runtime.pick(pickStartIn)}
                  className={`flex items-center gap-1.5 rounded-lg ${tones.button} px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50`}
                >
                  <HardDriveDownload size={15} /> 授权访问
                </button>
              )
            ) : (
              <>
                <button
                  type="button"
                  disabled={!supported}
                  onClick={() => void runtime.pick(pickStartIn)}
                  className={`flex items-center gap-1.5 rounded-lg ${tones.button} px-3 py-2 text-sm font-medium text-white transition-colors disabled:opacity-50`}
                >
                  <HardDriveDownload size={15} />
                  {handle ? '更换文件夹' : '选择本地文件夹'}
                </button>
                {handle && (
                  <button
                    type="button"
                    onClick={() => void runtime.disconnect()}
                    className={`p-2 rounded-lg transition-colors ${
                      isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100'
                    }`}
                    title="断开绑定"
                  >
                    <Unplug size={16} />
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {fixedPath && (
          <div className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${body}`}>
            <Folder size={14} className="mt-0.5 shrink-0 text-amber-400" />
            <div className="min-w-0">
              <p className={muted}>固定目录（不可更换）</p>
              <code className={`break-all font-medium ${tones.text}`}>{fixedPath}</code>
              <p className={`mt-1 ${muted}`}>
                浏览器首次需要手动授权一次：请选择「文稿 / Documents」下的
                <code className="mx-1">KnowledgeBase</code>
                文件夹。授权后长期有效，不需要也不允许在应用里更换。
              </p>
            </div>
          </div>
        )}

        {!supported && (
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
              isDark
                ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                : 'border-amber-200 bg-amber-50 text-amber-700'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              当前浏览器不支持本机文件夹访问（File System Access API）。请使用 Chrome / Edge
              桌面版，并确保通过 HTTPS 或 localhost 访问。
            </span>
          </div>
        )}

        {scopeSlot}

        {/* 已绑定目录 */}
        {handle && (
          <div className={`rounded-xl border p-3 ${body}`}>
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex items-center gap-2">
                <Folder size={14} className="text-amber-400 shrink-0" />
                <p className={`text-xs ${muted} shrink-0`}>已绑定文件夹</p>
                <p
                  className={`text-sm font-medium truncate ${isDark ? 'text-gray-200' : 'text-gray-900'}`}
                  title={runtime.dirName}
                >
                  {runtime.dirName}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {granted ? (
                  <span className={`flex items-center gap-1 text-xs ${isDark ? 'text-emerald-400' : 'text-emerald-600'}`}>
                    <CheckCircle2 size={14} /> 已授权
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => void runtime.reauthorize()}
                    className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium ${
                      isDark
                        ? 'border-amber-800 text-amber-300 hover:bg-amber-950/50'
                        : 'border-amber-300 text-amber-700 hover:bg-amber-50'
                    }`}
                  >
                    <ShieldAlert size={13} /> 重新授权
                  </button>
                )}
                {granted && lockDirectory && (
                  <button
                    type="button"
                    onClick={() => void runtime.pick(pickStartIn)}
                    className={`text-[11px] underline-offset-2 hover:underline ${muted}`}
                    title="仅在目录授权失效或选错时使用；目录名仍必须是 KnowledgeBase"
                  >
                    重新授权
                  </button>
                )}
              </div>
            </div>

            {entries && entries.length > 0 && (
              <div className="mt-2.5 border-t border-dashed border-gray-300 dark:border-gray-700 pt-2.5">
                <p className={`text-xs ${muted} mb-1.5`}>目录内容（{entries.length} 项）</p>
                <ul
                  className={`grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-1 text-xs ${
                    isDark ? 'text-gray-400' : 'text-gray-500'
                  }`}
                >
                  {entries.map((entry) => (
                    <li key={`${entry.kind}-${entry.name}`} className="flex items-center gap-1.5 min-w-0">
                      {entry.kind === 'directory' ? (
                        <Folder size={12} className="text-amber-400 shrink-0" />
                      ) : (
                        <FileText size={12} className="shrink-0" />
                      )}
                      <span className="truncate" title={entry.name}>
                        {entry.name}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {entries && entries.length === 0 && (
              <p className={`mt-2 text-xs ${muted}`}>
                该文件夹目前为空，执行一次同步后内容会写入这里。
              </p>
            )}
          </div>
        )}

        {/* 操作按钮 */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!handle || !granted || busy !== 'idle'}
            onClick={onCompare}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-50 ${
              isDark
                ? 'border-gray-700 text-gray-200 hover:bg-gray-700'
                : 'border-gray-200 text-gray-700 hover:bg-gray-100'
            }`}
          >
            {busy === 'compare' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            对比（只读）
          </button>
          <button
            type="button"
            disabled={!handle || !granted || busy !== 'idle'}
            onClick={onApply}
            className={`flex items-center gap-1.5 rounded-lg ${tones.button} px-3 py-2 text-sm font-medium text-white disabled:opacity-50 transition-colors`}
          >
            {busy === 'apply' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
            开始同步
          </button>
          {progress && (
            <span className={`text-xs ${muted}`}>
              {progress.phase}
              {progress.total > 0 ? ` ${progress.done}/${progress.total}` : ''}
            </span>
          )}
        </div>

        {error && (
          <p className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</p>
        )}

        {handle && persistent === false && (
          <div
            className={`flex items-start gap-2 rounded-xl border p-3 text-xs ${
              isDark
                ? 'border-amber-900/60 bg-amber-950/40 text-amber-300'
                : 'border-amber-200 bg-amber-50 text-amber-700'
            }`}
          >
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              浏览器未授予本站「持久化存储」。磁盘空间紧张或长时间不访问时，本地文件夹的授权记录
              <code className="mx-1">IndexedDB</code>
              可能被系统清除，届时需要重新绑定一次（已同步的文件不受影响）。
            </span>
          </div>
        )}

        {/* 规则（仅知识库源） */}
        {sourceKey === 'kb' && (
          <div className={`space-y-3 rounded-xl border p-3 ${body}`}>
            <div>
              <label className={`block text-xs font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                忽略清单（一行一条，相对知识库根）
              </label>
              <textarea
                value={ignoreDraft}
                onChange={(e) => setIgnoreDraft(e.target.value)}
                rows={5}
                spellCheck={false}
                className={`w-full rounded-lg border px-2.5 py-2 font-mono text-xs outline-none ${input}`}
              />
              <p className={`mt-1 text-xs ${muted}`}>
                <code>/AGENTS.md</code> 只匹配根目录；<code>archive/2025</code> 匹配该子树；
                <code>templates</code> 匹配任意层级的同名项。点开头的文件由系统自动跳过。
              </p>
            </div>
            <div>
              <label className={`flex items-center gap-1.5 text-xs font-medium mb-1.5 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
                <ShieldCheck size={13} className="text-emerald-500" />
                保护目录（只导入，禁止写回与删除）
              </label>
              <textarea
                value={protectDraft}
                onChange={(e) => setProtectDraft(e.target.value)}
                rows={3}
                spellCheck={false}
                className={`w-full rounded-lg border px-2.5 py-2 font-mono text-xs outline-none ${input}`}
              />
              <p className={`mt-1 text-xs ${muted}`}>
                对齐知识库 AGENTS.md 权限表：<code>raw/</code> 与 <code>templates/</code> 的原始资料
                永远不会被应用改写。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveRules}
                className="flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-700 transition-colors"
              >
                <Save size={13} />
                保存规则
              </button>
              {onResetPreset && (
                <button
                  type="button"
                  onClick={onResetPreset}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium ${
                    isDark
                      ? 'border-gray-700 text-gray-300 hover:bg-gray-700'
                      : 'border-gray-200 text-gray-600 hover:bg-gray-100'
                  }`}
                >
                  恢复知识库预设
                </button>
              )}
            </div>
          </div>
        )}

        {children}

        {/* 结果面板 */}
        {report && (
          <div className={`rounded-xl border p-4 space-y-3 ${body}`}>
            <div className="flex items-center justify-between">
              <h4 className={`text-sm font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>
                {report.mode === 'compare' ? '对比结果（未写入任何内容）' : '同步结果'}
              </h4>
              <span className={`text-xs ${muted}`}>耗时 {report.durationMs} ms</span>
            </div>

            {report.hashDegraded && (
              <p className={`text-xs ${isDark ? 'text-amber-300' : 'text-amber-700'}`}>
                当前非安全上下文，无法计算内容哈希，已降级为「文件大小 + 修改时间」判断变更。
              </p>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {report.direction === 'kb' && (
                <Stat label="导入新建" value={report.imported} isDark={isDark} />
              )}
              <Stat
                label={report.direction === 'kb' ? '写回本地' : '下载到本地'}
                value={report.downloaded}
                isDark={isDark}
              />
              <Stat
                label={report.direction === 'kb' ? '更新服务端' : '上传到服务端'}
                value={report.uploaded}
                isDark={isDark}
              />
              {report.direction !== 'kb' && (
                <>
                  <Stat label="冲突副本" value={report.conflicts.length} isDark={isDark} />
                  <Stat label="本地删除同步" value={report.localDeleted.length} isDark={isDark} />
                  <Stat label="远端删除移入回收站" value={report.remoteDeleted.length} isDark={isDark} />
                </>
              )}
              <Stat label="新建文件夹" value={report.uploadedFolders.length} isDark={isDark} />
              <Stat label="跳过加密文档" value={report.skippedEncrypted} isDark={isDark} />
              <Stat label="跳过文档笔记" value={report.skippedDocuments} isDark={isDark} />
              {report.direction === 'kb' && (
                <Stat label="跳过非文本文件" value={report.skippedUnsupported} isDark={isDark} />
              )}
            </div>

            {report.direction === 'kb' && (
              <p className={`text-xs ${isDark ? 'text-emerald-300' : 'text-emerald-700'}`}>
                知识库模式：本次运行未删除任何本地文件，未覆盖任何有未同步修改的文件。
              </p>
            )}

            {report.missingLocal.length > 0 && (
              <PathList title="本地文件已消失（服务端笔记已保留，未删除）" items={report.missingLocal} isDark={isDark} />
            )}
            {report.unlinkedLocal.length > 0 && (
              <PathList title="远端笔记已删除（本地文件已保留，仅解除映射）" items={report.unlinkedLocal} isDark={isDark} />
            )}
            {report.blockedByProtection.length > 0 && (
              <PathList title="命中保护目录，已拒绝写回" items={report.blockedByProtection} isDark={isDark} />
            )}
            {report.skippedRemoteChanges.length > 0 && (
              <PathList title="两端都改过：已以本地为准，远端变更未生效" items={report.skippedRemoteChanges} isDark={isDark} />
            )}
            {report.conflicts.length > 0 && (
              <PathList title="冲突副本（本地修改已保留）" items={report.conflicts} isDark={isDark} />
            )}
            {report.remoteDeleted.length > 0 && (
              <PathList title="已移入 .aidrivenote/trash/ 的文件" items={report.remoteDeleted} isDark={isDark} />
            )}
            {report.skippedLocalChanges.length > 0 && (
              <PathList
                title="未写入的本地差异（内容与远端不一致，或目标路径已被占用）"
                items={report.skippedLocalChanges}
                isDark={isDark}
              />
            )}
            {report.errors.length > 0 && (
              <div>
                <p className={`text-xs font-medium mb-1.5 ${isDark ? 'text-red-400' : 'text-red-600'}`}>
                  失败 {report.errors.length} 条
                </p>
                <ul className={`space-y-1 text-xs ${muted}`}>
                  {report.errors.map((e, i) => (
                    <li key={i} className="break-all">
                      {e.path}：{e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/** 统计数字卡片 */
const Stat: React.FC<{ label: string; value: number; isDark: boolean }> = ({ label, value, isDark }) => (
  <div
    className={`rounded-lg border p-2.5 ${
      isDark ? 'border-gray-700 bg-gray-900/40' : 'border-gray-200 bg-white'
    }`}
  >
    <p className={`text-[11px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>{label}</p>
    <p className={`text-base font-bold ${isDark ? 'text-gray-100' : 'text-gray-900'}`}>{value}</p>
  </div>
);

/** 路径列表 */
const PathList: React.FC<{ title: string; items: string[]; isDark: boolean }> = ({ title, items, isDark }) => (
  <div>
    <p className={`text-xs font-medium mb-1 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{title}</p>
    <ul className={`space-y-0.5 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
      {items.map((item) => (
        <li key={item} className="break-all">
          {item}
        </li>
      ))}
    </ul>
  </div>
);

export default SyncSourceCard;
