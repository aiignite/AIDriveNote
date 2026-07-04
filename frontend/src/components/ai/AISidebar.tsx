import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, History, Loader2, Plus, Send, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  aiApi,
  buildChatPageContext,
  type AIAssistant,
  type AIConversation,
} from '../../services/ai/ai';
import { noteApi } from '../../services/note';
import { useApp } from '../../contexts/AppContext';
import NoteChangeConfirmCard, { type NotePendingChange } from './NoteChangeConfirmCard';
import AIChatMarkdown from './AIChatMarkdown';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  notePendingChange?: NotePendingChange;
  applied?: boolean;
  dismissed?: boolean;
}

function parseNotePendingChange(result: Record<string, unknown>): NotePendingChange | null {
  if (!result?.requires_confirmation || !result?.note_id) return null;
  if (!result.proposed_content || typeof result.proposed_content !== 'object') return null;
  return {
    noteId: String(result.note_id),
    noteTitle: String(result.note_title || '笔记'),
    noteType: String(result.note_type || 'markdown'),
    changeType: result.change_type === 'append' ? 'append' : 'update',
    proposedContent: result.proposed_content as Record<string, unknown>,
    proposedTitle: result.proposed_title != null ? String(result.proposed_title) : null,
    previewText: String(result.preview_text || ''),
    addedPreviewText: result.added_preview_text != null ? String(result.added_preview_text) : null,
    currentPreviewText: result.current_preview_text != null ? String(result.current_preview_text) : null,
  };
}

const AISidebar: React.FC = () => {
  const { aiOpen, closeAI, pageAIContext, bumpNotesRefresh, theme } = useApp();
  const isDark = theme === 'dark';

  const [assistants, setAssistants] = useState<AIAssistant[]>([]);
  const [selectedAssistant, setSelectedAssistant] = useState('笔记助手');
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [showHistory, setShowHistory] = useState(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!aiOpen) return;
    void (async () => {
      try {
        const [asst, convs] = await Promise.all([
          aiApi.listAssistants(),
          aiApi.listConversations(),
        ]);
        setAssistants(asst);
        setConversations(convs);
        if (asst.length && !asst.find(a => a.name === selectedAssistant)) {
          setSelectedAssistant(asst.find(a => a.isDefault)?.name ?? asst[0].name);
        }
      } catch {
        /* ignore load errors */
      }
    })();
  }, [aiOpen, selectedAssistant]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, streamingContent]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const msgs = await aiApi.listMessages(id);
      setConversationId(id);
      setMessages(msgs.map(m => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })));
      setShowHistory(false);
    } catch {
      toast.error('加载会话失败');
    }
  }, []);

  const startNewConversation = useCallback(() => {
    setConversationId(undefined);
    setMessages([]);
    setShowHistory(false);
  }, []);

  const sendMessage = useCallback(async (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || loading) return;
    if (!textOverride) setInput('');
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);
    setStreamingContent('');

    let assistantContent = '';
    let pending: NotePendingChange | null = null;
    let newConversationId = conversationId;

    try {
      const stream = aiApi.chatStream({
        message: text,
        assistantName: selectedAssistant,
        conversationId,
        pageContext: buildChatPageContext(pageAIContext),
      });

      for await (const event of stream) {
        if (event.type === 'content' && event.content) {
          assistantContent += event.content;
          setStreamingContent(assistantContent);
        } else if (event.type === 'tool_result' && event.result) {
          const result = event.result;
          if (result.success === false && result.error) {
            assistantContent += `\n\n⚠️ ${result.error}`;
            setStreamingContent(assistantContent);
          }
          const preview = parseNotePendingChange(result);
          if (preview) pending = preview;
          if (result.message && typeof result.message === 'string') {
            assistantContent += `\n\n${result.message}`;
            setStreamingContent(assistantContent);
          }
        } else if (event.type === 'done' && event.conversationId) {
          newConversationId = event.conversationId;
        } else if (event.type === 'error' && event.content) {
          assistantContent += event.content;
          setStreamingContent(assistantContent);
        }
      }

      setConversationId(newConversationId);
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: assistantContent.trim() || '已完成操作。',
        notePendingChange: pending ?? undefined,
      }]);
      setStreamingContent('');

      if (newConversationId) {
        const convs = await aiApi.listConversations();
        setConversations(convs);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 请求失败');
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setLoading(false);
      setStreamingContent('');
    }
  }, [input, loading, selectedAssistant, conversationId, pageAIContext]);

  const handleApply = useCallback(async (index: number) => {
    const msg = messages[index];
    const pending = msg?.notePendingChange;
    if (!pending || pending.applied) return;
    setApplyingIndex(index);
    try {
      await noteApi.update(pending.noteId, {
        content: pending.proposedContent,
        title: pending.proposedTitle ?? undefined,
      });
      setMessages(prev => prev.map((m, i) =>
        i === index && m.notePendingChange
          ? { ...m, notePendingChange: { ...m.notePendingChange, applied: true } }
          : m,
      ));
      bumpNotesRefresh();
      toast.success('已应用到笔记');
    } catch {
      toast.error('应用失败');
    } finally {
      setApplyingIndex(null);
    }
  }, [messages, bumpNotesRefresh]);

  const handleDismiss = useCallback((index: number) => {
    setMessages(prev => prev.map((m, i) =>
      i === index && m.notePendingChange
        ? { ...m, notePendingChange: { ...m.notePendingChange, dismissed: true } }
        : m,
    ));
  }, []);

  const quickActions = pageAIContext?.quickActions ?? [];

  if (!aiOpen) return null;

  const currentAssistant = assistants.find(a => a.name === selectedAssistant);

  return (
    <div className={`fixed inset-y-0 right-0 z-40 w-full max-w-md flex flex-col border-l shadow-xl ${isDark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}>
      <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center gap-2 min-w-0">
          <Bot size={18} className="text-orange-500 shrink-0" />
          <select
            value={selectedAssistant}
            onChange={e => setSelectedAssistant(e.target.value)}
            className={`text-sm font-semibold bg-transparent outline-none truncate max-w-[140px] ${isDark ? 'text-white' : 'text-gray-900'}`}
          >
            {(assistants.length ? assistants : [{ name: '笔记助手' } as AIAssistant]).map(a => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
          {currentAssistant?.model && (
            <span className={`text-xs truncate hidden sm:inline ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
              {currentAssistant.model}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" onClick={startNewConversation} title="新对话" className={`p-1 rounded ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <Plus size={16} />
          </button>
          <button type="button" onClick={() => setShowHistory(v => !v)} title="历史" className={`p-1 rounded ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <History size={16} />
          </button>
          <button type="button" onClick={closeAI} className={`p-1 rounded ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}>
            <X size={18} />
          </button>
        </div>
      </div>

      {showHistory && (
        <div className={`max-h-40 overflow-y-auto border-b ${isDark ? 'border-gray-700 bg-gray-800' : 'border-gray-200 bg-gray-50'}`}>
          {conversations.length === 0 ? (
            <p className={`p-3 text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>暂无历史会话</p>
          ) : conversations.map(c => (
            <button
              key={c.id}
              type="button"
              onClick={() => void loadConversation(c.id)}
              className={`w-full text-left px-3 py-2 text-sm truncate ${isDark ? 'hover:bg-gray-700 text-gray-200' : 'hover:bg-gray-100 text-gray-700'} ${conversationId === c.id ? 'bg-orange-50 dark:bg-orange-900/30' : ''}`}
            >
              {c.title || '新对话'}
            </button>
          ))}
        </div>
      )}

      {quickActions.length > 0 && (
        <div className={`flex flex-wrap gap-1.5 px-3 py-2 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
          {quickActions.map(action => (
            <button
              key={action.label}
              type="button"
              disabled={loading}
              onClick={() => void sendMessage(action.prompt)}
              className={`text-xs px-2 py-1 rounded-full border ${isDark ? 'border-gray-600 text-gray-300 hover:bg-gray-800' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !streamingContent && (
          <p className={`text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
            问我关于笔记的任何问题：搜索、总结、续写、创建笔记等。
          </p>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={msg.role === 'user' ? 'text-right' : 'text-left'}>
            {msg.role === 'user' ? (
              <div className="inline-block max-w-[95%] rounded-xl px-3 py-2 text-sm whitespace-pre-wrap bg-orange-600 text-white">
                {msg.content}
              </div>
            ) : (
              <div className={`inline-block max-w-[95%] rounded-xl px-3 py-2 text-sm ${isDark ? 'bg-gray-800 text-gray-100' : 'bg-gray-100 text-gray-800'}`}>
                <AIChatMarkdown content={msg.content} />
              </div>
            )}
            {msg.role === 'assistant' && msg.notePendingChange && !msg.notePendingChange.dismissed && (
              <NoteChangeConfirmCard
                pending={msg.notePendingChange}
                applying={applyingIndex === idx}
                onApply={() => void handleApply(idx)}
                onDismiss={() => handleDismiss(idx)}
              />
            )}
          </div>
        ))}
        {streamingContent && (
          <div className={`rounded-xl px-3 py-2 text-sm ${isDark ? 'bg-gray-800 text-gray-100' : 'bg-gray-100 text-gray-800'}`}>
            <AIChatMarkdown content={streamingContent} />
          </div>
        )}
        {loading && !streamingContent && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin" /> 思考中…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className={`p-3 border-t ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex gap-2">
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), void sendMessage())}
            placeholder="输入消息…"
            className={`flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500 ${
              isDark ? 'bg-gray-800 border-gray-600 text-white' : 'bg-white border-gray-300'
            }`}
          />
          <button
            type="button"
            onClick={() => void sendMessage()}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-orange-600 text-white p-2 disabled:opacity-50"
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
};

export default AISidebar;
