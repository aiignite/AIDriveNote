/**
 * NoteMarkdownEditor – 基于 @uiw/react-md-editor 的 Markdown 编辑器
 * 默认纯编辑模式（更快），可切换实时预览。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eye } from 'lucide-react';
import MDEditor, { type PreviewType } from '@uiw/react-md-editor';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github.css';
import 'highlight.js/styles/github-dark.css';

interface NoteMarkdownEditorProps {
  noteId: string;
  content?: string;
  contentResetKey?: number;
  onChange?: (content: string) => void;
  readOnly?: boolean;
  isDark?: boolean;
}

const previewPlugins = [remarkGfm, remarkMath];
const previewRehypePlugins = [rehypeKatex, rehypeHighlight];

const NoteMarkdownEditorCore: React.FC<NoteMarkdownEditorProps> = ({
  noteId,
  content,
  onChange,
  readOnly = false,
  isDark = false,
}) => {
  const [value, setValue] = useState(content ?? '');
  const [preview, setPreview] = useState<PreviewType>('edit');
  const prevNoteIdRef = useRef(noteId);

  useEffect(() => {
    if (prevNoteIdRef.current !== noteId) {
      prevNoteIdRef.current = noteId;
      setValue(content ?? '');
    }
  }, [noteId, content]);

  const handleChange = useCallback(
    (val?: string) => {
      const next = val ?? '';
      setValue(next);
      onChange?.(next);
    },
    [onChange],
  );

  const togglePreview = useCallback(() => {
    setPreview(p => (p === 'edit' ? 'live' : 'edit'));
  }, []);

  return (
    <div
      className={`w-full h-full flex flex-col min-h-0 ${isDark ? 'note-md-dark' : ''}`}
      data-color-mode={isDark ? 'dark' : 'light'}
    >
      {!readOnly && (
        <div className={`flex items-center justify-end px-2 py-1 border-b shrink-0 ${isDark ? 'border-gray-700' : 'border-gray-100'}`}>
          <button
            type="button"
            onClick={togglePreview}
            className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md transition-colors ${
              preview === 'live'
                ? (isDark ? 'bg-orange-900/40 text-orange-300' : 'bg-orange-50 text-orange-600')
                : (isDark ? 'text-gray-400 hover:bg-gray-700' : 'text-gray-500 hover:bg-gray-100')
            }`}
          >
            <Eye size={13} />
            {preview === 'live' ? '实时预览' : '开启预览'}
          </button>
        </div>
      )}
      {readOnly ? (
        <MDEditor.Markdown
          source={value}
          remarkPlugins={previewPlugins}
          rehypePlugins={previewRehypePlugins}
          className="p-4 flex-1 overflow-auto"
        />
      ) : (
        <MDEditor
          value={value}
          onChange={handleChange}
          height="100%"
          visibleDragbar={false}
          preview={preview}
          className="flex-1 min-h-0"
          textareaProps={{ placeholder: '输入 Markdown 内容，支持 GFM、公式与代码高亮' }}
          previewOptions={{
            remarkPlugins: previewPlugins,
            rehypePlugins: previewRehypePlugins,
          }}
        />
      )}
    </div>
  );
};

const NoteMarkdownEditor: React.FC<NoteMarkdownEditorProps> = (props) => {
  const { contentResetKey = 0, ...rest } = props;
  return <NoteMarkdownEditorCore key={contentResetKey} {...rest} />;
};

export default NoteMarkdownEditor;
