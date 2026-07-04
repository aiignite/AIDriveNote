/**
 * NoteFlowchartEditor – 基于 Drawio (embed.diagrams.net) 的流程图编辑器
 * 参照 AIIgniteNote DrawioEditor 风格
 */
import React, { useEffect, useRef, useCallback, useState } from 'react';

interface NoteFlowchartEditorProps {
  noteId: string;
  content?: string;
  contentResetKey?: number;
  onChange?: (content: string) => void;
  readOnly?: boolean;
  isDark?: boolean;
}

const DRAWIO_URL = 'https://embed.diagrams.net/?embed=1&spin=1&proto=json&configure=1';

const DEFAULT_XML = `<mxGraphModel>
  <root>
    <mxCell id="0"/>
    <mxCell id="1" parent="0"/>
    <mxCell id="2" value="开始" style="rounded=1;whiteSpace=wrap;" vertex="1" parent="1">
      <mxGeometry x="200" y="40" width="120" height="40" as="geometry"/>
    </mxCell>
    <mxCell id="3" value="处理" style="whiteSpace=wrap;" vertex="1" parent="1">
      <mxGeometry x="200" y="120" width="120" height="40" as="geometry"/>
    </mxCell>
    <mxCell id="4" style="" edge="1" source="2" target="3" parent="1">
      <mxGeometry relative="1" as="geometry"/>
    </mxCell>
  </root>
</mxGraphModel>`;

const NoteFlowchartEditor: React.FC<NoteFlowchartEditorProps> = ({
  noteId,
  content,
  contentResetKey = 0,
  onChange,
  readOnly = false,
  isDark = false,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [timedOut, setTimedOut] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const contentRef = useRef(content);
  const prevNoteIdRef = useRef(noteId);
  const lastResetKeyRef = useRef(contentResetKey);

  contentRef.current = content;

  const postMessage = useCallback((msg: Record<string, unknown>) => {
    iframeRef.current?.contentWindow?.postMessage(JSON.stringify(msg), '*');
  }, []);

  useEffect(() => {
    const handler = (evt: MessageEvent) => {
      if (!evt.data || typeof evt.data !== 'string') return;
      let msg: any;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }

      if (msg.event === 'configure') {
        postMessage({
          action: 'configure',
          config: {
            darkMode: isDark,
            defaultFonts: ['Helvetica', 'Verdana', 'Times New Roman', 'Garamond'],
          },
        });
      } else if (msg.event === 'init') {
        setReady(true);
        postMessage({
          action: 'load',
          xml: contentRef.current || DEFAULT_XML,
          autosave: 1,
        });
      } else if (msg.event === 'autosave') {
        onChange?.(msg.xml);
      } else if (msg.event === 'save') {
        onChange?.(msg.xml);
        // 告诉 drawio 保存完毕
        postMessage({ action: 'status', modified: false });
      } else if (msg.event === 'export') {
        onChange?.(msg.xml || msg.data);
      }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [isDark, onChange, postMessage]);

  // 切换笔记或 AI 刷新时重新加载 XML
  useEffect(() => {
    if (!ready) return;
    const noteChanged = prevNoteIdRef.current !== noteId;
    const resetChanged = lastResetKeyRef.current !== contentResetKey;
    prevNoteIdRef.current = noteId;
    lastResetKeyRef.current = contentResetKey;
    if (!noteChanged && !resetChanged && content === contentRef.current) return;
    contentRef.current = content;
    postMessage({ action: 'load', xml: content || DEFAULT_XML, autosave: 1 });
  }, [ready, noteId, content, contentResetKey, postMessage]);

  useEffect(() => {
    setReady(false);
    setTimedOut(false);
    const timer = setTimeout(() => setTimedOut(true), 10000);
    return () => clearTimeout(timer);
  }, [retryKey]);

  const url = `${DRAWIO_URL}&dark=${isDark ? '1' : '0'}`;

  if (readOnly && content) {
    // 只读模式使用 viewer
    return (
      <div className={`w-full h-full ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
        <iframe
          ref={iframeRef}
          src={`https://viewer.diagrams.net/?highlight=0000ff&nav=1&dark=${isDark ? '1' : '0'}#R${encodeURIComponent(content)}`}
          className="w-full h-full border-0"
          title="Flowchart Viewer"
        />
      </div>
    );
  }

  return (
    <div className={`w-full h-full relative ${isDark ? 'bg-gray-800' : 'bg-white'}`}>
      {/* Loading overlay */}
      {!ready && !timedOut && (
        <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
          <div className="w-10 h-10 border-2 border-orange-500 border-t-transparent rounded-full animate-spin" />
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>正在加载流程图编辑器…</p>
        </div>
      )}
      {/* Timeout retry */}
      {timedOut && !ready && (
        <div className={`absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 ${isDark ? 'bg-gray-800' : 'bg-gray-50'}`}>
          <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>加载超时，请检查网络连接</p>
          <button
            onClick={() => { setRetryKey(k => k + 1); }}
            className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
          >
            重试
          </button>
        </div>
      )}
      <iframe
        key={retryKey}
        ref={iframeRef}
        src={url}
        className="w-full h-full border-0"
        title="Drawio Editor"
      />
    </div>
  );
};

export default NoteFlowchartEditor;
