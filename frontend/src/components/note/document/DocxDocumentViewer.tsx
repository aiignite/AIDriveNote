import React, { useEffect, useRef, useState } from 'react';
import { preflightZip } from './documentLimits';

interface Props {
  bytes: Uint8Array;
  isDark: boolean;
}

/** 移除渲染结果中可执行/可外联的内容（docx-preview 输出的是 HTML）。 */
function cleanRenderedDom(root: HTMLElement): void {
  root.querySelectorAll('script, iframe, object, embed, link, meta').forEach((node) => node.remove());
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'href' && attr.value.trim().toLowerCase().startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
    if (el.tagName === 'IMG') {
      const src = el.getAttribute('src') || '';
      if (!src.startsWith('data:') && !src.startsWith('blob:')) el.removeAttribute('src');
    }
  });
}

const DocxDocumentViewer: React.FC<Props> = ({ bytes, isDark }) => {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const styleRef = useRef<HTMLStyleElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const body = bodyRef.current;
    if (body) body.innerHTML = '';

    const render = async () => {
      await preflightZip(bytes);
      const docx = await import('docx-preview');
      if (cancelled || !body) return;
      await docx.renderAsync(
        bytes.slice(0).buffer,
        body,
        styleRef.current ?? undefined,
        {
          inWrapper: true,
          breakPages: true,
          useBase64URL: true,
          renderHeaders: true,
          renderFooters: true,
          renderFootnotes: true,
          experimental: true,
        },
      );
      if (cancelled) return;
      cleanRenderedDom(body);
      setLoading(false);
    };

    void render().catch((err: unknown) => {
      if (cancelled) return;
      setLoading(false);
      setError(err instanceof Error ? err.message : 'Word 文档解析失败');
    });

    return () => {
      cancelled = true;
    };
  }, [bytes]);

  return (
    <div className={`h-full min-h-0 overflow-auto ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}>
      <style ref={styleRef} />
      {loading && !error && (
        <div className={`p-4 text-center text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          正在渲染 Word 文档…
        </div>
      )}
      {error ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-red-500">
          {error}
        </div>
      ) : (
        <div ref={bodyRef} className="docx-preview-host mx-auto my-4 bg-white shadow-lg" />
      )}
      <div className={`px-4 pb-3 text-center text-[10px] ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
        复杂版式、图表或宏可能在浏览器中失真，可下载原文件查看
      </div>
    </div>
  );
};

export default DocxDocumentViewer;
