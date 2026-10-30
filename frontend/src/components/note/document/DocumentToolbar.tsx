import React from 'react';
import { Download, Maximize2, Minimize2, FileText, Loader2, Sparkles } from 'lucide-react';
import type { NoteDocumentMeta } from '../../../services/note/note';
import { formatBytes, pageUnit } from './documentLimits';

interface Props {
  meta: NoteDocumentMeta;
  isDark: boolean;
  isFullscreen: boolean;
  downloading?: boolean;
  onDownload: () => void;
  onToggleFullscreen: () => void;
  onDistill?: () => void;
  distilling?: boolean;
  children?: React.ReactNode;
}

export const DocumentToolbar: React.FC<Props> = ({
  meta,
  isDark,
  isFullscreen,
  downloading = false,
  onDownload,
  onToggleFullscreen,
  onDistill,
  distilling = false,
  children,
}) => (
  <div
    className={`flex flex-wrap items-center gap-2 px-3 py-2 border-b shrink-0 ${
      isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'
    }`}
  >
    <FileText size={16} className="text-orange-600 shrink-0" />
    <div className="min-w-0 flex-1">
      <div className={`truncate text-xs font-medium ${isDark ? 'text-gray-200' : 'text-gray-700'}`}>
        {meta.fileName}
      </div>
      <div className={`text-[10px] ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
        {meta.ext.replace('.', '').toUpperCase()} · {formatBytes(meta.sizeBytes)}
        {meta.pageCount ? ` · ${meta.pageCount}${pageUnit(meta.ext)}` : ''}
      </div>
    </div>
    {children}
    {onDistill && (
      <button
        type="button"
        onClick={onDistill}
        disabled={distilling}
        className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
          isDark
            ? 'text-orange-300 hover:bg-gray-700 disabled:opacity-50'
            : 'text-orange-600 hover:bg-orange-50 disabled:opacity-50'
        }`}
        title="蒸馏成知识卡，送入知识收件箱审核"
      >
        {distilling ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
        抽取知识
      </button>
    )}
    <button
      type="button"
      onClick={onDownload}
      disabled={downloading}
      className={`inline-flex items-center gap-1 rounded px-2 py-1 text-[11px] transition-colors ${
        isDark
          ? 'text-gray-300 hover:bg-gray-700 disabled:opacity-50'
          : 'text-gray-600 hover:bg-gray-200 disabled:opacity-50'
      }`}
      title="下载原文件"
    >
      <Download size={14} />
      下载
    </button>
    <button
      type="button"
      onClick={onToggleFullscreen}
      className={`inline-flex items-center justify-center rounded p-1 transition-colors ${
        isDark ? 'text-gray-300 hover:bg-gray-700' : 'text-gray-600 hover:bg-gray-200'
      }`}
      title={isFullscreen ? '退出全屏' : '全屏'}
    >
      {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
    </button>
  </div>
);
