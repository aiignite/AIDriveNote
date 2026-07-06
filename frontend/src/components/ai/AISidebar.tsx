import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, History, Loader2, Plus, Send, Sparkles, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  aiApi,
  type AIAssistant,
  type AIConversation,
  type AIModel,
} from '../../services/ai/ai';
import { useApp } from '../../contexts/AppContext';
import { useAIChat } from '../../hooks/useAIChat';
import NoteChangeConfirmCard from './NoteChangeConfirmCard';
import AIChatMarkdown from './AIChatMarkdown';

const AISidebar: React.FC = () => {
  const {
    aiOpen, closeAI, pageAIContext, bumpNotesRefresh, theme,
    aiPreset, clearAIPreset, sidebarWidth, setSidebarWidth,
  } = useApp();
  const isDark = theme === 'dark';

  const [assistants, setAssistants] = useState<AIAssistant[]>([]);
  const [models, setModels] = useState<AIModel[]>([]);
  const [selectedAssistant, setSelectedAssistant] = useState('笔记助手');
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>();
  const [conversations, setConversations] = useState<AIConversation[]>([]);
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [showHistory, setShowHistory] = useState(false);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    messages, loading, streamingContent, activeSkill, applyingIndex,
    sendMessage, handleApply, handleConfirmDelete, handleDismiss,
    loadMessagesFromHistory, setMessages,
  } = useAIChat({
    pageAIContext,
    bumpNotesRefresh,
    selectedAssistant,
    conversationId,
    modelId: selectedModelId,
    onConversationId: setConversationId,
  });

  useEffect(() => {
    if (!aiOpen) return;
    void (async () => {
      try {
        const [asst, convs, modelList, settings] = await Promise.all([
          aiApi.listAssistants(),
          aiApi.listConversations(),
          aiApi.listModels().catch(() => [] as AIModel[]),
          aiApi.getSettings().catch(() => null),
        ]);
        setAssistants(asst);
        setConversations(convs);
        setModels(modelList);
        if (settings?.sidebarWidth) setSidebarWidth(settings.sidebarWidth);

        const recommended = pageAIContext?.recommendedAssistant;
        if (recommended && asst.find(a => a.name === recommended)) {
          setSelectedAssistant(recommended);
        } else if (asst.length && !asst.find(a => a.name === selectedAssistant)) {
          setSelectedAssistant(asst.find(a => a.isDefault)?.name ?? asst[0].name);
        }
      } catch {
        /* ignore load errors */
      }
    })();
  }, [aiOpen, pageAIContext?.recommendedAssistant, selectedAssistant, setSidebarWidth]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading, streamingContent]);

  useEffect(() => {
    if (!aiOpen || !aiPreset) return;
    const { presetMessage, selectionText } = aiPreset;
    clearAIPreset();
    if (presetMessage) {
      void sendMessage(presetMessage, selectionText);
    }
    inputRef.current?.focus();
  }, [aiOpen, aiPreset, clearAIPreset, sendMessage]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const msgs = await aiApi.listMessages(id);
      setConversationId(id);
      loadMessagesFromHistory(msgs);
      setShowHistory(false);
    } catch {
      toast.error('加载会话失败');
    }
  }, [loadMessagesFromHistory]);

  const startNewConversation = useCallback(() => {
    setConversationId(undefined);
    setMessages([]);
    setShowHistory(false);
  }, [setMessages]);

  const onSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setInput('');
    void sendMessage(text);
  }, [input, sendMessage]);

  const quickActions = pageAIContext?.quickActions ?? [];

  if (!aiOpen) return null;

  const currentAssistant = assistants.find(a => a.name === selectedAssistant);
  const panelWidth = Math.min(Math.max(sidebarWidth, 320), 600);

  return (
    <div
      className={`fixed inset-y-0 right-0 z-40 flex flex-col border-l shadow-xl ${isDark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}
      style={{ width: panelWidth, maxWidth: '100vw' }}
    >
      <div className={`flex items-center justify-between px-4 py-3 border-b ${isDark ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Bot size={18} className="text-orange-500 shrink-0" />
          <select
            value={selectedAssistant}
            onChange={e => setSelectedAssistant(e.target.value)}
            className={`text-sm font-semibold bg-transparent outline-none truncate max-w-[120px] ${isDark ? 'text-white' : 'text-gray-900'}`}
          >
            {(assistants.length ? assistants : [{ name: '笔记助手' } as AIAssistant]).map(a => (
              <option key={a.name} value={a.name}>{a.name}</option>
            ))}
          </select>
          {models.length > 0 && (
            <select
              value={selectedModelId ?? ''}
              onChange={e => setSelectedModelId(e.target.value || undefined)}
              className={`text-xs bg-transparent outline-none truncate max-w-[100px] ${isDark ? 'text-gray-400' : 'text-gray-500'}`}
              title="会话模型"
            >
              <option value="">默认模型</option>
              {models.map(m => (
                <option key={m.id} value={m.modelId}>{m.name}</option>
              ))}
            </select>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
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

      {activeSkill && (
        <div className={`px-3 py-1.5 border-b flex items-center gap-1.5 text-xs ${isDark ? 'border-gray-700 bg-orange-950/20 text-orange-300' : 'border-orange-100 bg-orange-50 text-orange-700'}`}>
          <Sparkles size={12} />
          <span>{activeSkill.name}</span>
          {activeSkill.reason && (
            <span className={`truncate ${isDark ? 'text-orange-400/70' : 'text-orange-600/70'}`}>· {activeSkill.reason}</span>
          )}
        </div>
      )}

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
            {msg.role === 'assistant' && msg.deletePending && (
              <div className="mt-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50/60 dark:bg-red-950/20 p-3">
                <p className="text-xs text-red-800 dark:text-red-200 mb-2">
                  确认删除笔记「{msg.deletePending.noteTitle}」？
                </p>
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setMessages(prev => prev.map((m, i) => i === idx ? { ...m, deletePending: undefined } : m))} className="px-3 py-1.5 text-xs rounded-lg">取消</button>
                  <button type="button" disabled={applyingIndex === idx} onClick={() => void handleConfirmDelete(idx)} className="px-3 py-1.5 text-xs rounded-lg bg-red-600 text-white">确认删除</button>
                </div>
              </div>
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
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), onSend())}
            placeholder="输入消息… (⌘J 聚焦)"
            className={`flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-orange-500 ${
              isDark ? 'bg-gray-800 border-gray-600 text-white' : 'bg-white border-gray-300'
            }`}
          />
          <button
            type="button"
            onClick={onSend}
            disabled={loading || !input.trim()}
            className="rounded-lg bg-orange-600 text-white p-2 disabled:opacity-50"
          >
            <Send size={18} />
          </button>
        </div>
        {currentAssistant?.model && !selectedModelId && (
          <p className={`text-[10px] mt-1 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>模型: {currentAssistant.model}</p>
        )}
      </div>
    </div>
  );
};

export default AISidebar;
