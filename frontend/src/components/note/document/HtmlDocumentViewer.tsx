import React, { useEffect, useMemo, useState } from 'react';
import { decodeText, sanitizeHtml } from './documentLimits';

interface Props {
  bytes: Uint8Array;
  isDark: boolean;
}

const HtmlDocumentViewer: React.FC<Props> = ({ bytes, isDark }) => {
  const sanitized = useMemo(() => sanitizeHtml(decodeText(bytes)), [bytes]);
  const [url, setUrl] = useState<string>('');

  useEffect(() => {
    const blob = new Blob([sanitized], { type: 'text/html;charset=utf-8' });
    const next = URL.createObjectURL(blob);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [sanitized]);

  return (
    <div className={`flex h-full min-h-0 flex-col ${isDark ? 'bg-gray-900' : 'bg-gray-100'}`}>
      <div
        className={`px-3 py-1 text-[10px] ${isDark ? 'bg-gray-800 text-gray-500' : 'bg-white text-gray-400'}`}
      >
        已禁用脚本、表单与外部资源；如需完整效果请下载原文件
      </div>
      {url ? (
        <iframe
          title="HTML 文档预览"
          src={url}
          sandbox=""
          referrerPolicy="no-referrer"
          style={{ width: '100%' }}
          className="block w-full min-h-0 flex-1 border-0 bg-white"
        />
      ) : (
        <div className={`flex flex-1 items-center justify-center text-xs ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
          正在解析 HTML…
        </div>
      )}
    </div>
  );
};

export default HtmlDocumentViewer;
