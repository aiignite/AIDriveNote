import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, History, Loader2, Plus, Sparkles, X } from 'lucide-react';
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
import AIChatInput, { createPendingAttachment, type PendingAttachment } from './AIChatInput';
import MessageAttachmentGallery from './MessageAttachmentGallery';
import { stripAttachmentMarkers } from '../../utils/aiAttachmentDisplay';

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
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages, loading, streamingContent, activeSkill, applyingIndex,
    sendMessage, handleApply, handleApplyStreaming, handleConfirmDelete, handleDismiss,
    loadMessagesFromHistory, setMessages, streamingPending, setStreamingPending, stopGeneration,
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
  }, [messages, loading, streamingContent, pendingFiles]);

  useEffect(() => {
    if (!aiOpen || !aiPreset) return;
    const { presetMessage, selectionText } = aiPreset;
    clearAIPreset();
    if (presetMessage) {
      void sendMessage(presetMessage, { selectionText });
    }
    inputRef.current?.focus();
  }, [aiOpen, aiPreset, clearAIPreset, sendMessage]);

  const revokePendingPreview = useCallback((entry: PendingAttachment) => {
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  }, []);

  const uploadPendingFiles = useCallback((fileList: File[]) => {
    if (fileList.length === 0) return;

    const newEntries = fileList.map(createPendingAttachment);
    setPendingFiles(prev => [...prev, ...newEntries]);

    const attemptUpload = async (entry: PendingAttachment, retriesLeft = 1) => {
      try {
        const result = await aiApi.uploadAttachment(
          entry.file,
          conversationId ? { conversationId } : undefined,
        );
        const attachmentId = result.data?.id;
        if (result.success !== false && attachmentId) {
          setPendingFiles(prev => prev.map(p =>
            p.localId === entry.localId
              ? { ...p, uploading: false, serverId: attachmentId, error: undefined }
              : p,
          ));
          return;
        }
        throw new Error('upload rejected');
      } catch {
        if (retriesLeft > 0) {
          await attemptUpload(entry, retriesLeft - 1);
          return;
        }
        setPendingFiles(prev => prev.map(p =>
          p.localId === entry.localId
            ? { ...p, uploading: false, error: '预上传未完成' }
            : p,
        ));
      }
    };

    for (const entry of newEntries) {
      void attemptUpload(entry);
    }
  }, [conversationId]);

  const handleRemoveFile = useCallback((localId: string) => {
    setPendingFiles(prev => {
      const target = prev.find(p => p.localId === localId);
      if (target) revokePendingPreview(target);
      return prev.filter(p => p.localId !== localId);
    });
  }, [revokePendingPreview]);

  const pendingFilesRef = useRef(pendingFiles);
  pendingFilesRef.current = pendingFiles;

  useEffect(() => () => {
    pendingFilesRef.current.forEach(revokePendingPreview);
  }, [revokePendingPreview]);

  const loadConversation = useCallback(async (id: string) => {
    try {
      const msgs = await aiApi.listMessages(id);
      setConversationId(id);
      loadMessagesFromHistory(msgs);
      setShowHistory(false);
      setPendingFiles(prev => {
        prev.forEach(revokePendingPreview);
        return [];
      });
    } catch {
      toast.error('加载会话失败');
    }
  }, [loadMessagesFromHistory, revokePendingPreview]);

  const startNewConversation = useCallback(() => {
    setConversationId(undefined);
    setMessages([]);
    setShowHistory(false);
    setPendingFiles(prev => {
      prev.forEach(revokePendingPreview);
      return [];
    });
  }, [setMessages, revokePendingPreview]);

  const onSend = useCallback(async () => {
    const text = input.trim();
    const filesToProcess = [...pendingFiles];
    if (!text && filesToProcess.length === 0) return;

    const messageAttachments = filesToProcess.map(p => ({
      id: p.serverId,
      name: p.file.name,
      mimeType: p.file.type,
      previewUrl: p.previewUrl,
    }));

    setInput('');
    setPendingFiles([]);

    const attachmentIds = await Promise.all(filesToProcess.map(async (p) => {
      if (p.serverId) return p.serverId;
      try {
        const result = await aiApi.uploadAttachment(
          p.file,
          conversationId ? { conversationId } : undefined,
        );
        return result.success !== false && result.data?.id ? result.data.id : null;
      } catch {
        return null;
      }
    }));

    const validIds = attachmentIds.filter((id): id is string => Boolean(id));
    if (filesToProcess.length > 0 && validIds.length === 0) {
      toast.error('附件上传失败，请重试');
      setPendingFiles(filesToProcess);
      return;
    }

    void sendMessage(text, {
      attachmentIds: validIds,
      attachments: messageAttachments.length > 0 ? messageAttachments : undefined,
    });
  }, [input, pendingFiles, sendMessage, conversationId]);

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
            问我关于笔记的任何问题：搜索、总结、续写、创建笔记等。支持粘贴或上传图片。
          </p>
        )}
        {messages.map((msg, idx) => (
          <div key={idx} className={msg.role === 'user' ? 'text-right' : 'text-left'}>
            <div className={`inline-block max-w-[95%] rounded-xl px-3 py-2 text-sm ${
              msg.role === 'user'
                ? 'bg-orange-600 text-white text-left'
                : isDark ? 'bg-gray-800 text-gray-100' : 'bg-gray-100 text-gray-800'
            }`}>
              <MessageAttachmentGallery
                attachments={msg.attachments}
                variant={msg.role === 'user' ? 'inverted' : 'default'}
                className={msg.attachments?.length ? 'mb-2' : ''}
              />
              {msg.role === 'user' ? (
                msg.content ? (
                  <p className="whitespace-pre-wrap">{stripAttachmentMarkers(msg.content)}</p>
                ) : null
              ) : (
                <AIChatMarkdown content={msg.content} />
              )}
            </div>
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
        {streamingPending && !streamingPending.applied && !streamingPending.dismissed && (
          <NoteChangeConfirmCard
            pending={streamingPending}
            applying={applyingIndex != null}
            onApply={() => void handleApplyStreaming()}
            onDismiss={() => setStreamingPending(prev => prev ? { ...prev, dismissed: true } : null)}
          />
        )}
        {loading && !streamingContent && (
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Loader2 size={16} className="animate-spin" /> 思考中…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <AIChatInput
        value={input}
        onChange={setInput}
        onSend={() => void onSend()}
        onStop={stopGeneration}
        loading={loading}
        pendingFiles={pendingFiles}
        onSelectFiles={uploadPendingFiles}
        onRemoveFile={handleRemoveFile}
        isDark={isDark}
        inputRef={inputRef}
      />

      {currentAssistant?.model && !selectedModelId && (
        <p className={`text-[10px] px-3 pb-2 ${isDark ? 'text-gray-600' : 'text-gray-400'}`}>
          模型: {currentAssistant.model}
        </p>
      )}
    </div>
  );
};

export default AISidebar;
