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

interface SlideSize {
  width: number;
  height: number;
}

/** 翻页栏 + 底部说明 + 上下留白占用的高度 */
const CHROME_HEIGHT = 96;
/** 单张幻灯片的最大渲染宽度，避免超大屏把解析和排版拖慢 */
const MAX_RENDER_WIDTH = 2560;

/**
 * 按容器可用空间计算幻灯片渲染尺寸（16:9）。
 *
 * pptx-preview 的 width/height 是初始化时的固定值，没有 resize 能力，
 * 因此必须在外层容器尺寸变化时重新初始化。这里同时用可用宽和高做约束，
 * 保证全屏或分屏时幻灯片既铺满宽度，也不会超出可视高度。
 * @param container 预览容器
 * @returns 渲染宽高
 */
function fitSlide(container: HTMLElement): SlideSize {
  // 用 getBoundingClientRect 而不是 clientWidth：滚动条出现/消失不会改变它，
  // 避免“宽度变化 → 出现滚动条 → 再次变化”的反复重建。
  const availWidth = Math.max(320, container.getBoundingClientRect().width - 32);
  const availHeight = Math.max(200, container.clientHeight - CHROME_HEIGHT);
  const width = Math.round(
    clamp(Math.min(availWidth, (availHeight * 16) / 9), 320, MAX_RENDER_WIDTH),
  );
  return { width, height: Math.round((width * 9) / 16) };
}

const PptxDocumentViewer: React.FC<Props> = ({ bytes, isDark }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const previewerRef = useRef<PreviewerLike | null>(null);
  const indexRef = useRef(0);
  const [size, setSize] = useState<SlideSize | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slideCount, setSlideCount] = useState(0);
  const [index, setIndex] = useState(0);

  // 跟随容器尺寸：全屏切换、侧栏拖拽、窗口缩放都会重新计算渲染尺寸
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const update = () => {
      setSize((prev) => {
        const next = fitSlide(container);
        return prev && prev.width === next.width && prev.height === next.height
          ? prev
          : next;
      });
    };

    update();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }

    let timer: number | undefined;
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer);
      timer = window.setTimeout(update, 160);
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      window.clearTimeout(timer);
    };
  }, []);

  // 尺寸变化或文件变化时重建预览器；重建后尽量停留在当前页
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !size) return;

    let cancelled = false;
    let instance: PreviewerLike | null = null;

    try {
      previewerRef.current?.destroy?.();
    } catch {
      /* ignore */
    }
    previewerRef.current = null;
    host.innerHTML = '';
    setLoading(true);
    setError(null);

    const render = async () => {
      await preflightZip(bytes);
      if (cancelled) return;
      const { init } = await import('pptx-preview');
      instance = init(host, {
        width: size.width,
        height: size.height,
        mode: 'slide',
      }) as unknown as PreviewerLike;
      previewerRef.current = instance;
      await instance.preview(bytes.slice(0).buffer);
      if (cancelled) return;
      const count = instance.slideCount || 0;
      setSlideCount(count);
      const target = count ? clamp(indexRef.current, 0, count - 1) : 0;
      if (target > 0) instance.renderSingleSlide(target);
      indexRef.current = target;
      setIndex(target);
      setLoading(false);
    };

    void render().catch((err: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : 'PPT 文档解析失败');
    });

    return () => {
      cancelled = true;
      try {
        instance?.destroy?.();
      } catch {
        /* ignore */
      }
      if (previewerRef.current === instance) previewerRef.current = null;
    };
  }, [bytes, size]);

  const go = useCallback((next: number) => {
    const previewer = previewerRef.current;
    if (!previewer || !slideCount) return;
    const target = clamp(next, 0, slideCount - 1);
    previewer.renderSingleSlide(target);
    indexRef.current = target;
    setIndex(target);
  }, [slideCount]);

  return (
    <div
      ref={containerRef}
      className={`h-full min-h-0 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}
    >
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
