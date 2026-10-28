import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { noteApi } from '../services/note';

/**
 * PWA 分享目标：系统分享面板把标题/正文/链接带进来，
 * 这里直接落成一条 Markdown 笔记并跳转到笔记页。
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
        const note = await noteApi.create({
          title: fallbackTitle,
          noteType: 'markdown',
          content: { text: body },
        });
        navigate(`/note/${note.id}`, { replace: true });
      } catch (err) {
        setError(err instanceof Error ? err.message : '保存分享内容失败');
      }
    })();
  }, [navigate, searchParams]);

  return (
    <div className="flex h-full items-center justify-center bg-slate-50 dark:bg-gray-950">
      <p className="text-sm text-gray-500 dark:text-gray-400">
        {error || '正在保存分享内容…'}
      </p>
    </div>
  );
};

export default ShareTargetPage;
