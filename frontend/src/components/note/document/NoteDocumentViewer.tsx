import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Download, FileText, RefreshCw } from 'lucide-react';
import toast from 'react-hot-toast';
import type { NoteDocumentMeta } from '../../../services/note/note';
import { noteDocumentApi } from '../../../services/note/note';
import { knowledgeApi } from '../../../services/knowledge';
import { DocumentToolbar } from './DocumentToolbar';
import { useDocumentBytes } from './useDocumentBytes';
import { formatBytes } from './documentLimits';
import PdfDocumentViewer from './PdfDocumentViewer';
import DocxDocumentViewer from './DocxDocumentViewer';
import XlsxDocumentViewer from './XlsxDocumentViewer';
import PptxDocumentViewer from './PptxDocumentViewer';
import HtmlDocumentViewer from './HtmlDocumentViewer';

interface Props {
  noteId: string;
  meta: NoteDocumentMeta;
  isDark?: boolean;
  unlockToken?: string | null;
  publicToken?: string | null;
}

class DocumentErrorBoundary extends React.Component<
  { children: React.ReactNode; fallback: React.ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error('文档渲染失败', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const NoteDocumentViewer: React.FC<Props> = ({
  noteId,
  meta,
  isDark = false,
  unlockToken,
  publicToken,
}) => {
  const [fullscreen, setFullscreen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [distilling, setDistilling] = useState(false);
  const { bytes, loading, error, reload } = useDocumentBytes({
    noteId,
    etag: meta.etag,
    unlockToken,
    publicToken,
    enabled: meta.viewable,
  });

  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [fullscreen]);

  const download = useCallback(async () => {
    setDownloading(true);
    try {
      const blob = bytes
        ? new Blob([bytes as unknown as BlobPart], { type: meta.mime || 'application/octet-stream' })
        : publicToken
          ? await noteDocumentApi.publicFetchBytes(publicToken)
          : await noteDocumentApi.fetchBytes(noteId, unlockToken);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = meta.fileName || 'document';
      anchor.rel = 'noopener';
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } finally {
      setDownloading(false);
    }
  }, [bytes, meta.fileName, meta.mime, noteId, publicToken, unlockToken]);

  const distill = useCallback(async () => {
    setDistilling(true);
    try {
      const result = await knowledgeApi.distillNote(noteId);
      toast.success(
        result.duplicate
          ? '该文档已抽取过，未重复生成知识卡'
          : '已送入知识收件箱，审核后生成知识笔记',
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '抽取知识失败');
    } finally {
      setDistilling(false);
    }
  }, [noteId]);

  const fallback = (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertTriangle size={28} className="text-orange-500" />
      <div className={`text-sm ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>
        该文件暂时无法在浏览器中预览
      </div>
      <div className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
        {meta.fileName} · {formatBytes(meta.sizeBytes)}
      </div>
      <button
        type="button"
        onClick={() => void download()}
        className="inline-flex items-center gap-1 rounded bg-orange-600 px-3 py-1.5 text-xs text-white hover:bg-orange-700"
      >
        <Download size={14} />
        下载原文件
      </button>
    </div>
  );

  const renderBody = () => {
    if (!meta.viewable) return fallback;
    if (loading) {
      return (
        <div className={`flex h-full flex-col items-center justify-center gap-2 text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          <div className="h-7 w-7 animate-spin rounded-full border-b-2 border-orange-600" />
          正在加载原文件…
        </div>
      );
    }
    if (error || !bytes) {
      return (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <AlertTriangle size={26} className="text-orange-500" />
          <div className={`text-xs ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
            {error || '原文件加载失败'}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={reload}
              className="inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1 text-xs text-gray-600 hover:bg-gray-50"
            >
              <RefreshCw size={13} />
              重试
            </button>
            <button
              type="button"
              onClick={() => void download()}
              className="inline-flex items-center gap-1 rounded bg-orange-600 px-3 py-1 text-xs text-white hover:bg-orange-700"
            >
              <Download size={13} />
              下载原文件
            </button>
          </div>
        </div>
      );
    }

    const ext = meta.ext.toLowerCase();
    const content = (() => {
      if (ext === '.pdf') return <PdfDocumentViewer bytes={bytes} isDark={isDark} />;
      if (ext === '.docx') return <DocxDocumentViewer bytes={bytes} isDark={isDark} />;
      if (ext === '.xlsx') return <XlsxDocumentViewer bytes={bytes} isDark={isDark} />;
      if (ext === '.pptx') return <PptxDocumentViewer bytes={bytes} isDark={isDark} />;
      if (ext === '.html' || ext === '.htm') return <HtmlDocumentViewer bytes={bytes} isDark={isDark} />;
      return fallback;
    })();

    return <DocumentErrorBoundary fallback={fallback}>{content}</DocumentErrorBoundary>;
  };

  return (
    <div
      className={
        fullscreen
          ? `safe-top safe-bottom fixed inset-0 z-[99999] flex flex-col ${isDark ? 'bg-gray-900' : 'bg-white'}`
          : 'flex h-full min-h-0 flex-col'
      }
    >
      <DocumentToolbar
        meta={meta}
        isDark={isDark}
        isFullscreen={fullscreen}
        downloading={downloading}
        onDownload={() => void download()}
        onToggleFullscreen={() => setFullscreen((value) => !value)}
        onDistill={publicToken ? undefined : () => void distill()}
        distilling={distilling}
      />
      <div className="min-h-0 flex-1">{renderBody()}</div>
      {!meta.viewable && (
        <div className={`flex items-center justify-center gap-1 border-t px-3 py-1.5 text-[10px] ${isDark ? 'border-gray-700 text-gray-500' : 'border-gray-200 text-gray-400'}`}>
          <FileText size={12} />
          旧版 Office 格式（.doc/.xls/.ppt）仅支持下载
        </div>
      )}
    </div>
  );
};

export default NoteDocumentViewer;
