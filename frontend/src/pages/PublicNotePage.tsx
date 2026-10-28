import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { noteApi } from '../services/note';
import { contentToPlainText } from '../utils/noteDiff';

/** 公开只读笔记页（无需登录，按分享 token 访问）。 */
const PublicNotePage: React.FC = () => {
  const { token } = useParams<{ token: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState<{
    title: string;
    noteType: string;
    content: unknown;
    updatedAt?: string | null;
  } | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void (async () => {
      try {
        const data = await noteApi.publicGet(token);
        if (!cancelled) setNote(data);
      } catch {
        if (!cancelled) setError('链接无效、已过期或已被撤销');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div className="min-h-screen bg-slate-50 px-4 py-10 dark:bg-gray-950">
      <div className="mx-auto max-w-3xl rounded-2xl border border-gray-200 bg-white p-6 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <div className="mb-4 flex items-center gap-2 text-xs text-gray-400">
          <FileText size={14} />
          AIDriveNote · 公开只读笔记
        </div>
        {loading && <p className="text-sm text-gray-400">加载中…</p>}
        {error && <p className="text-sm text-red-500">{error}</p>}
        {note && (
          <>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{note.title}</h1>
            {note.updatedAt && (
              <p className="mt-1 text-xs text-gray-400">
                更新于 {new Date(note.updatedAt).toLocaleString('zh-CN')}
              </p>
            )}
            <pre className="mt-5 whitespace-pre-wrap break-words font-sans text-sm leading-7 text-gray-700 dark:text-gray-300">
              {contentToPlainText(note.noteType as never, note.content)}
            </pre>
          </>
        )}
      </div>
    </div>
  );
};

export default PublicNotePage;
