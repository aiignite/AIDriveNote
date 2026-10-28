import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { clamp, MAX_PPTX_SLIDES, preflightZip } from './documentLimits';

interface Props {
  bytes: Uint8Array;
  isDark: boolean;
}

interface PreviewerLike {
  slideCount: number;
  currentIndex: number;
  preview: (file: ArrayBuffer) => Promise<unknown>;
  renderSingleSlide: (index: number) => void;
  destroy: () => void;
}

const PptxDocumentViewer: React.FC<Props> = ({ bytes, isDark }) => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previewerRef = useRef<PreviewerLike | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [index, setIndex] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const host = hostRef.current;
    setLoading(true);
    setError(null);
    setSlideCount(0);
    setIndex(0);
    if (host) host.innerHTML = '';

    const load = async () => {
      await preflightZip(bytes);
      if (cancelled || !host) return;
      const { init } = await import('pptx-preview');
      const width = clamp(host.clientWidth - 32 || 720, 320, 960);
      const instance = init(host, {
        width,
        height: Math.round((width * 9) / 16),
        mode: 'slide',
      }) as unknown as PreviewerLike;
      previewerRef.current = instance;
      await instance.preview(bytes.slice(0).buffer);
      if (cancelled) return;
      setSlideCount(instance.slideCount || 0);
      setIndex(0);
      setLoading(false);
    };

    void load().catch((err: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : 'PPT 文档解析失败');
    });

    return () => {
      cancelled = true;
      try {
        previewerRef.current?.destroy?.();
      } catch {
        /* ignore */
      }
      previewerRef.current = null;
    };
  }, [bytes]);

  const go = useCallback((next: number) => {
    const previewer = previewerRef.current;
    if (!previewer || !slideCount) return;
    const target = clamp(next, 0, slideCount - 1);
    previewer.renderSingleSlide(target);
    setIndex(target);
  }, [slideCount]);

  return (
    <div className={`h-full min-h-0 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}>
      {/* 隐藏库自带的悬浮翻页按钮，改用下方工具栏 */}
      <style>{'.pptx-preview-wrapper-next,.pptx-preview-wrapper-pagination{display:none!important}'}</style>
      {loading && !error && (
        <div className={`p-4 text-center text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          正在渲染 PPT…
        </div>
      )}
      {error ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-red-500">
          {error}
        </div>
      ) : (
        <>
          <div
            className={`flex items-center justify-center gap-2 border-b py-1.5 text-xs ${
              isDark ? 'border-gray-700 bg-gray-800 text-gray-300' : 'border-gray-200 bg-white text-gray-600'
            }`}
          >
            <button
              type="button"
              onClick={() => go(index - 1)}
              disabled={index <= 0}
              className="rounded p-1 hover:bg-gray-500/10 disabled:opacity-40"
              title="上一页"
            >
              <ChevronLeft size={15} />
            </button>
            <span>{slideCount ? `${index + 1} / ${slideCount}` : '-'}</span>
            <button
              type="button"
              onClick={() => go(index + 1)}
              disabled={!slideCount || index >= slideCount - 1}
              className="rounded p-1 hover:bg-gray-500/10 disabled:opacity-40"
              title="下一页"
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div ref={hostRef} className="mx-auto my-4 bg-white shadow-lg" />
          {slideCount > MAX_PPTX_SLIDES && (
            <div className="pb-2 text-center text-[10px] text-orange-500">
              幻灯片较多，建议下载原文件查看
            </div>
          )}
          <div className={`pb-3 text-center text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
            复杂动画、图表或字体可能在浏览器中失真，可下载原文件查看
          </div>
        </>
      )}
    </div>
  );
};

export default PptxDocumentViewer;
