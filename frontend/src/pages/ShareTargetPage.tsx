import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { knowledgeApi } from '../services/knowledge';

/**
 * PWA 分享目标：系统分享面板把标题/正文/链接带进来，
 * 这里送入知识入库管线，异步解析、蒸馏后进入「知识收件箱」审核。
 */
const ShareTargetPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [error, setError] = useState('');
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const title = (searchParams.get('title') || '').trim();
    const text = (searchParams.get('text') || '').trim();
    const url = (searchParams.get('url') || '').trim();
    const body = [text, url].filter(Boolean).join('\n\n');
    const fallbackTitle = (title || text.split('\n')[0] || '分享的内容').slice(0, 60);

    void (async () => {
      try {
        await knowledgeApi.ingestDocument({
          sourceType: 'web_clip',
          externalId: url || undefined,
          title: fallbackTitle,
          text: body || fallbackTitle,
          url: url || undefined,
          rawMeta: { sharedFrom: 'pwa' },
        });
        navigate('/inbox', { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存分享内容失败');
      }
    })();
  }, [navigate, searchParams]);

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-gray-950">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {error || '正在送入知识收件箱…'}
      </p>
    </div>
  );
};

export default ShareTargetPage;
