/**
 * useAIChat — AI 侧栏聊天逻辑（流式、工具结果、笔记变更确认）
 */
import { useCallback, useState } from 'react';
import toast from 'react-hot-toast';
import {
  aiApi,
  buildChatPageContext,
  type PageAIContext,
} from '../services/ai/ai';
import { noteApi } from '../services/note';
import type { NotePendingChange } from '../components/ai/NoteChangeConfirmCard';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  notePendingChange?: NotePendingChange;
  deletePending?: { noteId: string; noteTitle: string };
  applied?: boolean;
  dismissed?: boolean;
}

export function parseNotePendingChange(result: Record<string, unknown>): NotePendingChange | null {
  if (!result?.requires_confirmation || !result?.note_id) return null;
  if (result.change_type === 'delete') return null;
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

export function parseDeletePending(result: Record<string, unknown>): { noteId: string; noteTitle: string } | null {
  if (!result?.requires_confirmation || result.change_type !== 'delete') return null;
  if (!result.note_id) return null;
  return { noteId: String(result.note_id), noteTitle: String(result.note_title || '笔记') };
}

interface UseAIChatOptions {
  pageAIContext: PageAIContext | null;
  bumpNotesRefresh: () => void;
  selectedAssistant: string;
  conversationId?: string;
  modelId?: string;
  onConversationId?: (id: string) => void;
}

export function useAIChat({
  pageAIContext,
  bumpNotesRefresh,
  selectedAssistant,
  conversationId,
  modelId,
  onConversationId,
}: UseAIChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState('');
  const [activeSkill, setActiveSkill] = useState<{ name: string; reason?: string } | null>(null);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);

  const sendMessage = useCallback(async (textOverride?: string, selectionTextOverride?: string) => {
    const text = (textOverride ?? '').trim();
    if (!text || loading) return;

    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setLoading(true);
    setStreamingContent('');
    setActiveSkill(null);

    let assistantContent = '';
    let pending: NotePendingChange | null = null;
    let deletePending: { noteId: string; noteTitle: string } | null = null;
    let newConversationId = conversationId;

    const ctx = pageAIContext
      ? {
          ...pageAIContext,
          ...(selectionTextOverride ? { selectionText: selectionTextOverride } : {}),
        }
      : null;

    try {
      const stream = aiApi.chatStream({
        message: text,
        assistantName: selectedAssistant,
        conversationId,
        modelId,
        pageContext: buildChatPageContext(ctx),
      });

      for await (const event of stream) {
        if (event.type === 'skill_match' && event.skillName) {
          setActiveSkill({ name: event.skillName, reason: event.reason });
        } else if (event.type === 'content' && event.content) {
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
          const del = parseDeletePending(result);
          if (del) deletePending = del;
          if (result.message && typeof result.message === 'string') {
            assistantContent += `\n\n${result.message}`;
            setStreamingContent(assistantContent);
          }
        } else if (event.type === 'done' && event.conversationId) {
          newConversationId = event.conversationId;
          onConversationId?.(event.conversationId);
        } else if (event.type === 'error' && event.content) {
          assistantContent += event.content;
          setStreamingContent(assistantContent);
        }
      }

      setMessages(prev => [...prev, {
        role: 'assistant',
        content: assistantContent.trim() || '已完成操作。',
        notePendingChange: pending ?? undefined,
        deletePending: deletePending ?? undefined,
      }]);
      setStreamingContent('');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'AI 请求失败');
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setLoading(false);
      setStreamingContent('');
    }
  }, [loading, selectedAssistant, conversationId, modelId, pageAIContext, onConversationId]);

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

  const handleConfirmDelete = useCallback(async (index: number) => {
    const msg = messages[index];
    const pending = msg?.deletePending;
    if (!pending) return;
    setApplyingIndex(index);
    try {
      await noteApi.delete(pending.noteId);
      setMessages(prev => prev.map((m, i) =>
        i === index ? { ...m, deletePending: undefined, content: m.content + '\n\n✅ 笔记已删除' } : m,
      ));
      bumpNotesRefresh();
      toast.success('笔记已删除');
    } catch {
      toast.error('删除失败');
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

  const loadMessagesFromHistory = useCallback((raw: Array<{ role: string; content: string; toolResults?: Array<{ result: Record<string, unknown> }> }>) => {
    setMessages(raw.map(m => {
      let notePendingChange: NotePendingChange | undefined;
      if (m.role === 'assistant' && m.toolResults) {
        for (const tr of m.toolResults) {
          const parsed = parseNotePendingChange(tr.result || {});
          if (parsed && !parsed.applied) {
            notePendingChange = parsed;
            break;
          }
        }
      }
      return {
        role: m.role as 'user' | 'assistant',
        content: m.content,
        notePendingChange,
      };
    }));
  }, []);

  return {
    messages,
    setMessages,
    loading,
    streamingContent,
    activeSkill,
    applyingIndex,
    sendMessage,
    handleApply,
    handleConfirmDelete,
    handleDismiss,
    loadMessagesFromHistory,
  };
}
