import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Minus, Plus } from 'lucide-react';
import { clamp, MAX_CANVAS_PIXELS, MAX_PDF_PAGES } from './documentLimits';
import { useWheelPaging } from './useWheelPaging';

interface Props {
  bytes: Uint8Array;
  isDark: boolean;
}

interface PdfDocumentLike {
  numPages: number;
  getPage: (index: number) => Promise<{
    getViewport: (params: { scale: number }) => { width: number; height: number };
    render: (params: Record<string, unknown>) => { promise: Promise<void>; cancel: () => void };
  }>;
  destroy: () => Promise<void>;
}

const ZOOM_STEP = 0.2;

const PdfDocumentViewer: React.FC<Props> = ({ bytes, isDark }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const pdfRef = useRef<PdfDocumentLike | null>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [baseWidth, setBaseWidth] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setError(null);
    setNumPages(0);
    setPage(1);

    const load = async () => {
      const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdfjs/pdf.worker.min.mjs`;
      const task = pdfjs.getDocument({
        data: bytes.slice(0),
        cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
      });
      const pdf = (await task.promise) as unknown as PdfDocumentLike;
      if (cancelled) {
        try {
          void pdf.destroy().catch(() => {
            /* ignore */
          });
        } catch {
          /* ignore */
        }
        return;
      }
      pdfRef.current = pdf;
      setNumPages(pdf.numPages);
      setReady(true);
      const first = await pdf.getPage(1);
      if (!cancelled) setBaseWidth(first.getViewport({ scale: 1 }).width);
    };

    void load().catch((err: unknown) => {
      if (cancelled) return;
      setError(err instanceof Error ? err.message : 'PDF 解析失败');
    });

    return () => {
      cancelled = true;
      try {
        renderTaskRef.current?.cancel();
      } catch {
        /* ignore */
      }
      renderTaskRef.current = null;
      const pdf = pdfRef.current;
      pdfRef.current = null;
      if (pdf) {
        try {
          void pdf.destroy().catch(() => {
            /* 组件卸载时销毁失败不影响界面 */
          });
        } catch {
          /* 同步抛错同样忽略 */
        }
      }
    };
  }, [bytes]);

  useEffect(() => {
    if (!ready) return;
    const pdf = pdfRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;

    let cancelled = false;
    renderTaskRef.current?.cancel();

    const render = async () => {
      const pdfPage = await pdf.getPage(page);
      if (cancelled) return;
      const viewport = pdfPage.getViewport({ scale });
      const context = canvas.getContext('2d');
      if (!context) return;

      let dpr = Math.min(window.devicePixelRatio || 1, 2);
      while (viewport.width * viewport.height * dpr * dpr > MAX_CANVAS_PIXELS) {
        dpr /= 2;
      }
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;

      const task = pdfPage.render({
        canvasContext: context,
        viewport,
        transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0],
      });
      renderTaskRef.current = task;
      await task.promise;
    };

    void render().catch((err: unknown) => {
      if (cancelled) return;
      const name = err instanceof Error ? err.name : '';
      if (name !== 'RenderingCancelledException') {
        setError(err instanceof Error ? err.message : 'PDF 页面渲染失败');
      }
    });

    return () => {
      cancelled = true;
    };
  }, [page, scale, ready]);

  const fitWidth = useCallback(() => {
    const width = containerRef.current?.clientWidth ?? 800;
    if (!baseWidth) return;
    setScale(clamp((width - 48) / baseWidth, 0.25, 3));
  }, [baseWidth]);

  const go = useCallback((next: number) => {
    setPage((value) => clamp(next, 1, numPages || 1));
    // 翻页后回到页首；页面比容器高时，用户先滚动到边缘才会触发翻页
    containerRef.current?.scrollTo({ top: 0 });
  }, [numPages]);

  useWheelPaging(containerRef, {
    canGo: (direction) => (direction > 0 ? page < numPages : page > 1),
    go: (direction) => go(page + direction),
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={`flex flex-wrap items-center justify-center gap-1 px-2 py-1.5 border-b text-xs shrink-0 ${
          isDark ? 'border-gray-700 bg-gray-800/70 text-gray-300' : 'border-gray-200 bg-white text-gray-600'
        }`}
      >
        <button type="button" onClick={() => go(page - 1)} disabled={page <= 1} className="rounded p-1 hover:bg-gray-500/10 disabled:opacity-40" title="上一页">
          <ChevronLeft size={15} />
        </button>
        <input
          value={page}
          onChange={(event) => {
            const value = Number(event.target.value);
            if (Number.isFinite(value)) go(value);
          }}
          className={`w-12 rounded border px-1 py-0.5 text-center text-xs ${
            isDark ? 'border-gray-600 bg-gray-900 text-gray-200' : 'border-gray-300 bg-white'
          }`}
          aria-label="页码"
        />
        <span className={isDark ? 'text-gray-500' : 'text-gray-400'} title="鼠标滚轮可翻页">
          / {numPages || '-'}
        </span>
        <button type="button" onClick={() => go(page + 1)} disabled={page >= numPages} className="rounded p-1 hover:bg-gray-500/10 disabled:opacity-40" title="下一页">
          <ChevronRight size={15} />
        </button>
        <span className="mx-2 h-4 w-px bg-gray-500/30" />
        <button type="button" onClick={() => setScale((value) => clamp(value - ZOOM_STEP, 0.25, 3))} className="rounded p-1 hover:bg-gray-500/10" title="缩小">
          <Minus size={15} />
        </button>
        <span className="w-10 text-center">{Math.round(scale * 100)}%</span>
        <button type="button" onClick={() => setScale((value) => clamp(value + ZOOM_STEP, 0.25, 3))} className="rounded p-1 hover:bg-gray-500/10" title="放大">
          <Plus size={15} />
        </button>
        <button type="button" onClick={fitWidth} className="rounded px-1.5 py-0.5 hover:bg-gray-500/10">适宽</button>
        {numPages > MAX_PDF_PAGES && (
          <span className="text-[10px] text-orange-500">页数较多，建议下载查看</span>
        )}
      </div>
      <div
        ref={containerRef}
        className={`flex-1 min-h-0 overflow-auto p-4 ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}
      >
        {error ? (
          <div className="flex h-full items-center justify-center text-xs text-red-500">{error}</div>
        ) : (
          <div className="flex min-h-full justify-center">
            <canvas ref={canvasRef} className="shadow-lg" />
          </div>
        )}
      </div>
    </div>
  );
};

export default PdfDocumentViewer;
