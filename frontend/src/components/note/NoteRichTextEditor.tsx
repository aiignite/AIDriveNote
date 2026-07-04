/**
 * NoteRichTextEditor – 基于 BlockNote 的块式富文本编辑器（类 Notion）
 * 单实例 + replaceBlocks 切换笔记；contentResetKey 变化时整实例重建（AI 刷新）。
 */
import React, { useCallback, useEffect, useRef } from 'react';
import { BlockNoteEditor, PartialBlock } from '@blocknote/core';
import { useCreateBlockNote } from '@blocknote/react';
import { BlockNoteView } from '@blocknote/mantine';
import {
  Bold, Italic, Strikethrough, Underline, Code,
  List, ListOrdered, CheckSquare,
  Heading1, Heading2, Heading3,
  Undo2, Redo2,
  AlignLeft, AlignCenter, AlignRight,
} from 'lucide-react';
import { parseBlockNoteContent } from '../../utils/blocknoteContent';
import '@blocknote/core/fonts/inter.css';
import '@blocknote/mantine/style.css';

const DEFAULT_BLOCKS: PartialBlock[] = [{ type: 'paragraph', props: { textAlignment: 'left' } }];

interface NoteRichTextEditorProps {
  noteId: string;
  content?: Record<string, unknown>;
  contentResetKey?: number;
  onChange?: (content: Record<string, unknown>) => void;
  readOnly?: boolean;
  isDark?: boolean;
}

const NoteRichTextEditorCore: React.FC<NoteRichTextEditorProps> = ({
  noteId,
  content,
  onChange,
  readOnly = false,
  isDark = false,
}) => {
  const editor: BlockNoteEditor = useCreateBlockNote({
    initialContent: parseBlockNoteContent(content) ?? DEFAULT_BLOCKS,
  });

  const prevNoteIdRef = useRef(noteId);
  const contentSigRef = useRef('');
  const suppressChangeRef = useRef(true);

  const applyContent = useCallback((nextContent?: Record<string, unknown>) => {
    const blocks = parseBlockNoteContent(nextContent) ?? DEFAULT_BLOCKS;
    editor.replaceBlocks(editor.document, blocks);
    suppressChangeRef.current = true;
    window.setTimeout(() => {
      suppressChangeRef.current = false;
    }, 800);
  }, [editor]);

  useEffect(() => {
    suppressChangeRef.current = true;
    const timer = window.setTimeout(() => {
      suppressChangeRef.current = false;
    }, 800);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const sig = JSON.stringify(content ?? null);
    if (prevNoteIdRef.current !== noteId) {
      prevNoteIdRef.current = noteId;
      contentSigRef.current = sig;
      applyContent(content);
      return;
    }
    if (contentSigRef.current !== sig) {
      contentSigRef.current = sig;
      applyContent(content);
    }
  }, [noteId, content, applyContent]);

  const handleChange = useCallback(() => {
    if (suppressChangeRef.current || !onChange || !editor) return;
    onChange({ blocks: editor.document });
  }, [onChange, editor]);

  const btnCls = `p-1.5 rounded-md transition-colors ${isDark ? 'text-gray-400 hover:text-white hover:bg-gray-600' : 'text-gray-500 hover:text-gray-800 hover:bg-gray-200'}`;
  const sepCls = `w-px h-5 mx-1 ${isDark ? 'bg-gray-600' : 'bg-gray-200'}`;

  const toggleStyle = (style: string) => {
    editor.focus();
    editor.toggleStyles({ [style]: true });
  };

  const insertBlock = (type: string, props?: Record<string, unknown>) => {
    editor.focus();
    const block = editor.getTextCursorPosition().block;
    editor.updateBlock(block, { type: type as any, props: props as any });
  };

  const setAlignment = (align: 'left' | 'center' | 'right') => {
    editor.focus();
    const block = editor.getTextCursorPosition().block;
    editor.updateBlock(block, { props: { textAlignment: align } as any });
  };

  return (
    <div className="w-full h-full flex flex-col overflow-hidden">
      {!readOnly && (
        <div className={`flex items-center gap-0.5 px-3 py-1.5 border-b shrink-0 flex-wrap ${isDark ? 'border-gray-700 bg-gray-800/50' : 'border-gray-100 bg-gray-50/50'}`}>
          <button type="button" className={btnCls} onClick={() => editor.undo()} title="撤销 (Ctrl+Z)"><Undo2 size={16} /></button>
          <button type="button" className={btnCls} onClick={() => editor.redo()} title="重做 (Ctrl+Y)"><Redo2 size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => insertBlock('heading', { level: 1 })} title="标题1"><Heading1 size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('heading', { level: 2 })} title="标题2"><Heading2 size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('heading', { level: 3 })} title="标题3"><Heading3 size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => toggleStyle('bold')} title="粗体"><Bold size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('italic')} title="斜体"><Italic size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('underline')} title="下划线"><Underline size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('strike')} title="删除线"><Strikethrough size={16} /></button>
          <button type="button" className={btnCls} onClick={() => toggleStyle('code')} title="行内代码"><Code size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('codeBlock')} title="代码块"><Code size={16} className="opacity-70" /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => insertBlock('bulletListItem')} title="无序列表"><List size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('numberedListItem')} title="有序列表"><ListOrdered size={16} /></button>
          <button type="button" className={btnCls} onClick={() => insertBlock('checkListItem')} title="待办列表"><CheckSquare size={16} /></button>
          <div className={sepCls} />
          <button type="button" className={btnCls} onClick={() => setAlignment('left')} title="左对齐"><AlignLeft size={16} /></button>
          <button type="button" className={btnCls} onClick={() => setAlignment('center')} title="居中"><AlignCenter size={16} /></button>
          <button type="button" className={btnCls} onClick={() => setAlignment('right')} title="右对齐"><AlignRight size={16} /></button>
        </div>
      )}
      <div className="flex-1 overflow-auto min-h-0">
        <BlockNoteView
          editor={editor}
          editable={!readOnly}
          theme={isDark ? 'dark' : 'light'}
          onChange={handleChange}
        />
      </div>
    </div>
  );
};

const NoteRichTextEditor: React.FC<NoteRichTextEditorProps> = (props) => {
  const { contentResetKey = 0, ...rest } = props;
  return (
    <NoteRichTextEditorCore
      key={contentResetKey}
      {...rest}
    />
  );
};

export default NoteRichTextEditor;
