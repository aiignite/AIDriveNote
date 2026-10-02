/**
 * NoteEditorContainer – 根据 note_type 按需加载对应编辑器
 *
 * 同时承担「命令注册链路」的透传：编辑器通过 onRegistryChange 上报自己支持的
 * 命令与菜单组，通过 onOutlineChange 上报大纲数据，由 NoteEditorPanel 统一消费。
 */
import React, { Suspense, useCallback, useMemo, lazy, forwardRef } from 'react';
import type { NoteMindMapEditorHandle } from './NoteMindMapEditor';
import type { NoteEditorRegistry, NoteOutlineState } from '../../utils/noteCommands';

const NoteRichTextEditor = lazy(() => import('./NoteRichTextEditor'));
const NoteMarkdownEditor = lazy(() => import('./NoteMarkdownEditor'));
const NoteMindMapEditor = lazy(() => import('./NoteMindMapEditor'));
const NoteFlowchartEditor = lazy(() => import('./NoteFlowchartEditor'));

type NoteType = 'rich_text' | 'markdown' | 'mindmap' | 'flowchart';

interface NoteEditorContainerProps {
  noteId: string;
  noteType: NoteType;
  content?: unknown;
  contentResetKey?: number;
  onChange?: (content: unknown) => void;
  readOnly?: boolean;
  isDark?: boolean;
  /** 编辑器上报可用命令与菜单组 */
  onRegistryChange?: (registry: NoteEditorRegistry) => void;
  /** 大纲上报：编辑器上报大纲数据（无大纲能力时上报 null） */
  onOutlineChange?: (state: NoteOutlineState | null) => void;
  /** 请求打开录音转写面板（仅富文本编辑器支持） */
  onOpenRecording?: () => void;
}

function unwrapContent(noteType: NoteType, raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const obj = raw as Record<string, unknown>;
  if (noteType === 'markdown' && typeof obj.text === 'string') return obj.text;
  if (noteType === 'flowchart' && typeof obj.xml === 'string') return obj.xml;
  return raw;
}

function wrapContent(noteType: NoteType, editorValue: unknown): unknown {
  if (noteType === 'markdown' && typeof editorValue === 'string') return { text: editorValue };
  if (noteType === 'flowchart' && typeof editorValue === 'string') return { xml: editorValue };
  return editorValue;
}

const EditorFallback: React.FC<{ isDark?: boolean }> = ({ isDark = false }) => (
  <div className={`flex items-center justify-center h-full ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-orange-600" />
  </div>
);

const NoteEditorContainer = forwardRef<NoteMindMapEditorHandle, NoteEditorContainerProps>(({
  noteId,
  noteType,
  content,
  contentResetKey = 0,
  onChange,
  readOnly = false,
  isDark = false,
  onRegistryChange,
  onOutlineChange,
  onOpenRecording,
}, ref) => {
  const editorContent = useMemo(() => unwrapContent(noteType, content), [noteType, content]);

  const handleRichTextChange = useCallback((c: Record<string, unknown>) => onChange?.(c), [onChange]);
  const handleMarkdownChange = useCallback((c: string) => onChange?.(wrapContent('markdown', c)), [onChange]);
  const handleMindMapChange = useCallback((c: Record<string, unknown>) => onChange?.(c), [onChange]);
  const handleFlowchartChange = useCallback((c: string) => onChange?.(wrapContent('flowchart', c)), [onChange]);

  switch (noteType) {
    case 'rich_text':
      return (
        <Suspense fallback={<EditorFallback isDark={isDark} />}>
          <NoteRichTextEditor
            noteId={noteId}
            content={editorContent as Record<string, unknown>}
            contentResetKey={contentResetKey}
            onChange={handleRichTextChange}
            readOnly={readOnly}
            isDark={isDark}
            onRegistryChange={onRegistryChange}
            onOutlineChange={onOutlineChange}
            onOpenRecording={onOpenRecording}
          />
        </Suspense>
      );
    case 'markdown':
      return (
        <Suspense fallback={<EditorFallback isDark={isDark} />}>
          <NoteMarkdownEditor
            noteId={noteId}
            content={editorContent as string}
            contentResetKey={contentResetKey}
            onChange={handleMarkdownChange}
            readOnly={readOnly}
            isDark={isDark}
            onRegistryChange={onRegistryChange}
            onOutlineChange={onOutlineChange}
          />
        </Suspense>
      );
    case 'mindmap':
      return (
        <Suspense fallback={<EditorFallback isDark={isDark} />}>
          <NoteMindMapEditor
            ref={ref}
            noteId={noteId}
            contentResetKey={contentResetKey}
            content={editorContent as Record<string, unknown>}
            onChange={handleMindMapChange}
            readOnly={readOnly}
            isDark={isDark}
            onRegistryChange={onRegistryChange}
          />
        </Suspense>
      );
    case 'flowchart':
      return (
        <Suspense fallback={<EditorFallback isDark={isDark} />}>
          <NoteFlowchartEditor
            noteId={noteId}
            contentResetKey={contentResetKey}
            content={editorContent as string}
            onChange={handleFlowchartChange}
            readOnly={readOnly}
            isDark={isDark}
            onRegistryChange={onRegistryChange}
          />
        </Suspense>
      );
    default:
      return (
        <div className="flex items-center justify-center h-full text-gray-500 dark:text-gray-400">
          不支持的笔记类型: {noteType}
        </div>
      );
  }
});

NoteEditorContainer.displayName = 'NoteEditorContainer';

export default NoteEditorContainer;
