import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Bot, History, Plus, X } from 'lucide-react';
import toast from 'react-hot-toast';
import {
  aiApi,
  type AIAssistant,
  type AIConversation,
  type AIModel,
  type AISkill,
} from '../../services/ai/ai';
import { useApp } from '../../contexts/AppContext';
import { useAIChat } from '../../hooks/useAIChat';
import NoteChangeConfirmCard from './NoteChangeConfirmCard';
import AIChatMarkdown from './AIChatMarkdown';
import AIChatInput, { createPendingAttachment, type PendingAttachment } from './AIChatInput';
import MessageAttachmentGallery from './MessageAttachmentGallery';
import SkillActivationCard from './SkillActivationCard';
import ToolCallDisplay from './ToolCallDisplay';
import ChatThinkingIndicator, { extractThinkingContent } from './ChatThinkingIndicator';
import { stripAttachmentMarkers } from '../../utils/aiAttachmentDisplay';

/** AI 抽屉可拖动的宽度范围（与设置页保持一致） */
const SIDEBAR_MIN_WIDTH = 320;
const SIDEBAR_MAX_WIDTH = 600;

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
  const [skills, setSkills] = useState<AISkill[]>([]);
  const [pinnedSkillCodes, setPinnedSkillCodes] = useState<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  /** 拖动调整宽度时的起始状态（仅用于拖动计算，不参与渲染） */
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  /** 始终保存最新宽度，供拖动结束时持久化使用 */
  const widthRef = useRef(sidebarWidth);
  widthRef.current = sidebarWidth;

  /**
   * 拖动过程中：按鼠标水平位移换算新宽度并同步到全局状态。
   * 抽屉贴右侧，因此向左拖动（clientX 减小）应让宽度变大。
   * @param e 全局 mousemove 事件
   */
  const handleResizeMove = useCallback((e: MouseEvent) => {
    const state = dragRef.current;
    if (!state) return;
    const next = state.startWidth + (state.startX - e.clientX);
    setSidebarWidth(Math.min(Math.max(next, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH));
  }, [setSidebarWidth]);

  /**
   * 结束拖动：移除全局监听、恢复光标，并把最终宽度写入用户偏好。
   */
  const handleResizeEnd = useCallback(() => {
    if (!dragRef.current) return;
    dragRef.current = null;
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup', handleResizeEnd);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    void aiApi.updateSettings({ sidebarWidth: widthRef.current }).catch(() => {});
  }, [handleResizeMove]);

  /**
   * 开始拖动：记录起始位置与宽度，并绑定全局监听。
   * @param e 手柄上的 mousedown 事件
   */
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: widthRef.current };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', handleResizeMove);
    window.addEventListener('mouseup', handleResizeEnd);
  }, [handleResizeMove, handleResizeEnd]);

  // 组件卸载时兜底清理拖动监听，避免残留监听造成的异常
  useEffect(() => () => {
    window.removeEventListener('mousemove', handleResizeMove);
    window.removeEventListener('mouseup', handleResizeEnd);
  }, [handleResizeMove, handleResizeEnd]);

  const {
    messages, loading, streamingContent, applyingIndex,
    streamingActivatedSkills, streamingThinking, streamingToolCalls,
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
        const [asst, convs, modelList, settings, skillList] = await Promise.all([
          aiApi.listAssistants(),
          aiApi.listConversations(),
          aiApi.listModels().catch(() => [] as AIModel[]),
          aiApi.getSettings().catch(() => null),
          aiApi.listSkills().catch(() => [] as AISkill[]),
        ]);
        setAssistants(asst);
        setConversations(convs);
        setModels(modelList);
        setSkills(skillList.filter(s => s.isEnabled));
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

  /** 切换技能固定状态（固定后发送时以 force_skills 下发） */
  const toggleSkill = useCallback((code: string) => {
    setPinnedSkillCodes(prev =>
      prev.includes(code) ? prev.filter(c => c !== code) : [...prev, code],
    );
  }, []);

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
      forceSkills: pinnedSkillCodes.length > 0 ? pinnedSkillCodes : undefined,
    });
  }, [input, pendingFiles, sendMessage, conversationId, pinnedSkillCodes]);

  const quickActions = pageAIContext?.quickActions ?? [];

  if (!aiOpen) return null;

  const currentAssistant = assistants.find(a => a.name === selectedAssistant);
  const panelWidth = Math.min(Math.max(sidebarWidth, SIDEBAR_MIN_WIDTH), SIDEBAR_MAX_WIDTH);

  return (
    <div
      className={`fixed inset-y-0 right-0 z-40 flex flex-col border-l shadow-xl ${isDark ? 'bg-gray-900 border-gray-700' : 'bg-white border-gray-200'}`}
      style={{ width: panelWidth, maxWidth: '100vw' }}
    >
      {/* 左侧拖动条：按住可调整抽屉宽度 */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="拖动调整宽度"
        onMouseDown={handleResizeStart}
        className="absolute left-0 top-0 z-10 h-full w-1.5 cursor-col-resize transition-colors hover:bg-orange-500/60"
      />
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
                <>
                  {msg.activatedSkills && msg.activatedSkills.length > 0 && (
                    <SkillActivationCard skills={msg.activatedSkills} isDark={isDark} />
                  )}
                  {msg.toolCalls && msg.toolCalls.length > 0 && (
                    <ToolCallDisplay toolCalls={msg.toolCalls} isDark={isDark} />
                  )}
                  {(msg.thinking || extractThinkingContent(msg.content).thinking) && (
                    <ChatThinkingIndicator
                      thinking={msg.thinking || extractThinkingContent(msg.content).thinking}
                      isDark={isDark}
                    />
                  )}
                  <AIChatMarkdown content={msg.content} />
                </>
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
        {(streamingContent || streamingThinking || streamingToolCalls.length > 0 || loading) && (
          <div className={`rounded-xl px-3 py-2 text-sm ${isDark ? 'bg-gray-800 text-gray-100' : 'bg-gray-100 text-gray-800'}`}>
            {streamingActivatedSkills.length > 0 && (
              <SkillActivationCard skills={streamingActivatedSkills} isDark={isDark} />
            )}
            {streamingToolCalls.length > 0 && (
              <ToolCallDisplay toolCalls={streamingToolCalls} isDark={isDark} />
            )}
            {(streamingThinking || loading) && (
              <ChatThinkingIndicator
                thinking={streamingThinking}
                streaming={loading}
                isDark={isDark}
              />
            )}
            {streamingContent && <AIChatMarkdown content={streamingContent} />}
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
        skills={skills}
        pinnedSkillCodes={pinnedSkillCodes}
        onToggleSkill={toggleSkill}
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
