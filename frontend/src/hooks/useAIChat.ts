/**
 * useAIChat — AI 侧栏聊天逻辑（流式、工具结果、笔记变更确认、附件）
 */
import { useCallback, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  aiApi,
  buildChatPageContext,
  type ActivatedSkillInfo,
  type PageAIContext,
  type ToolCallEventItem,
} from '../services/ai/ai';
import { noteApi } from '../services/note';
import type { NotePendingChange } from '../components/ai/NoteChangeConfirmCard';
import type { MessageAttachmentItem } from '../components/ai/MessageAttachmentGallery';
import { mapApiMessageAttachments, stripAttachmentMarkers } from '../utils/aiAttachmentDisplay';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  attachments?: MessageAttachmentItem[];
  notePendingChange?: NotePendingChange;
  deletePending?: { noteId: string; noteTitle: string };
  /** 本轮激活的技能列表（用于技能卡片展示） */
  activatedSkills?: ActivatedSkillInfo[];
  /** 本轮工具执行记录（用于工具卡片展示） */
  toolCalls?: ToolCallEventItem[];
  /** 本轮思考过程（用于折叠展示） */
  thinking?: string;
  applied?: boolean;
  dismissed?: boolean;
}

export interface SendMessageOptions {
  selectionText?: string;
  attachmentIds?: string[];
  attachments?: MessageAttachmentItem[];
  /** 手动固定的技能 code 列表 */
  forceSkills?: string[];
}

export function parseNotePendingChange(result: Record<string, unknown>): NotePendingChange | null {
  const requiresConfirmation = result?.requires_confirmation ?? result?.requiresConfirmation;
  const noteId = result?.note_id ?? result?.noteId;
  const changeType = result?.change_type ?? result?.changeType;
  const proposedContent = result?.proposed_content ?? result?.proposedContent;
  if (!requiresConfirmation || !noteId) return null;
  if (changeType === 'delete') return null;
  if (!proposedContent || typeof proposedContent !== 'object') return null;
  return {
    noteId: String(noteId),
    noteTitle: String(result.note_title ?? result.noteTitle ?? '笔记'),
    noteType: String(result.note_type ?? result.noteType ?? 'markdown'),
    changeType: changeType === 'append' ? 'append' : 'update',
    proposedContent: proposedContent as Record<string, unknown>,
    proposedTitle: result.proposed_title != null
      ? String(result.proposed_title)
      : result.proposedTitle != null
        ? String(result.proposedTitle)
        : null,
    previewText: String(result.preview_text ?? result.previewText ?? ''),
    addedPreviewText: result.added_preview_text != null
      ? String(result.added_preview_text)
      : result.addedPreviewText != null
        ? String(result.addedPreviewText)
        : null,
    currentPreviewText: result.current_preview_text != null
      ? String(result.current_preview_text)
      : result.currentPreviewText != null
        ? String(result.currentPreviewText)
        : null,
  };
}

export function parseDeletePending(result: Record<string, unknown>): { noteId: string; noteTitle: string } | null {
  if (!result?.requires_confirmation || result.change_type !== 'delete') return null;
  if (!result.note_id) return null;
  return { noteId: String(result.note_id), noteTitle: String(result.note_title || '笔记') };
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
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
  const [streamingActivatedSkills, setStreamingActivatedSkills] = useState<ActivatedSkillInfo[]>([]);
  const [streamingThinking, setStreamingThinking] = useState('');
  const [streamingToolCalls, setStreamingToolCalls] = useState<ToolCallEventItem[]>([]);
  const [applyingIndex, setApplyingIndex] = useState<number | null>(null);
  const [streamingPending, setStreamingPending] = useState<NotePendingChange | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const stopGeneration = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const sendMessage = useCallback(async (
    textOverride?: string,
    options?: SendMessageOptions,
  ) => {
    const text = (textOverride ?? '').trim();
    const attachmentIds = (options?.attachmentIds ?? []).filter(Boolean);
    if ((!text && attachmentIds.length === 0) || loading) return;

    setMessages(prev => [...prev, {
      role: 'user',
      content: text,
      attachments: options?.attachments,
    }]);
    setLoading(true);
    setStreamingContent('');
    setStreamingPending(null);
    setActiveSkill(null);
    setStreamingActivatedSkills([]);
    setStreamingThinking('');
    setStreamingToolCalls([]);

    const controller = new AbortController();
    abortRef.current = controller;

    let assistantContent = '';
    let pending: NotePendingChange | null = null;
    let deletePending: { noteId: string; noteTitle: string } | null = null;
    let activatedSkills: ActivatedSkillInfo[] = [];
    let thinkingContent = '';
    const toolCalls: ToolCallEventItem[] = [];
    let aborted = false;

    const ctx = pageAIContext
      ? {
          ...pageAIContext,
          ...(options?.selectionText ? { selectionText: options.selectionText } : {}),
        }
      : null;

    try {
      const stream = aiApi.chatStream({
        message: text || '请查看我上传的附件并回答。',
        assistantName: selectedAssistant,
        conversationId,
        modelId,
        pageContext: buildChatPageContext(ctx),
        attachmentIds: attachmentIds.length > 0 ? attachmentIds : undefined,
        forceSkills: options?.forceSkills,
        signal: controller.signal,
      });

      for await (const event of stream) {
        if (event.type === 'skill_activated' && event.skills?.length) {
          activatedSkills = event.skills;
          setStreamingActivatedSkills(event.skills);
        } else if (event.type === 'skill_match' && event.skillName) {
          // 兼容旧事件：仅在无多技能事件时作为兜底
          if (activatedSkills.length === 0) {
            setActiveSkill({ name: event.skillName, reason: event.reason });
          }
        } else if (event.type === 'thinking' && event.content) {
          thinkingContent += event.content;
          setStreamingThinking(thinkingContent);
        } else if (event.type === 'tool_execution_start' && event.tool) {
          toolCalls.push({ name: event.tool, status: 'running' });
          setStreamingToolCalls([...toolCalls]);
        } else if (event.type === 'content' && event.content) {
          assistantContent += event.content;
          setStreamingContent(assistantContent);
        } else if (event.type === 'tool_result' && event.result) {
          // 将对应的 running 工具项置为终态，并记录摘要
          const toolName = event.tool;
          if (toolName) {
            const item = [...toolCalls].reverse().find(t => t.name === toolName && t.status === 'running');
            if (item) {
              const err = event.result.success === false ? String(event.result.error ?? '') : '';
              item.status = err ? 'error' : 'success';
              item.message = err
                || (typeof event.result.message === 'string' ? event.result.message : undefined);
              setStreamingToolCalls([...toolCalls]);
            }
          }
          const result = event.result;
          if (result.success === false && result.error) {
            assistantContent += `\n\n⚠️ ${result.error}`;
            setStreamingContent(assistantContent);
          }
          const preview = parseNotePendingChange(result);
          if (preview) {
            pending = preview;
            setStreamingPending(preview);
          }
          const del = parseDeletePending(result);
          if (del) deletePending = del;
          if (result.message && typeof result.message === 'string') {
            assistantContent += `\n\n${result.message}`;
            setStreamingContent(assistantContent);
          }
        } else if (event.type === 'done' && event.conversationId) {
          onConversationId?.(event.conversationId);
        } else if (event.type === 'error' && event.content) {
          assistantContent += event.content;
          setStreamingContent(assistantContent);
        }
      }

      const finalContent = assistantContent.trim();
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: finalContent || (
          (options?.attachmentIds?.length ?? 0) > 0
            ? '未能获取模型回复。请确认已选择支持图片的模型（如 Minimax），并重试。'
            : '已完成操作。'
        ),
        notePendingChange: pending ?? undefined,
        deletePending: deletePending ?? undefined,
        activatedSkills: activatedSkills.length > 0 ? activatedSkills : undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        thinking: thinkingContent.trim() || undefined,
      }]);
      setStreamingContent('');
    } catch (err) {
      if (isAbortError(err)) {
        aborted = true;
        const partial = assistantContent.trim();
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: partial || '（已停止生成）',
          notePendingChange: pending ?? undefined,
          deletePending: deletePending ?? undefined,
          activatedSkills: activatedSkills.length > 0 ? activatedSkills : undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          thinking: thinkingContent.trim() || undefined,
        }]);
        setStreamingContent('');
        setStreamingPending(null);
      } else {
        toast.error(err instanceof Error ? err.message : 'AI 请求失败');
        setMessages(prev => prev.slice(0, -1));
        setStreamingPending(null);
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
      if (!aborted) {
        setStreamingContent('');
      }
      setActiveSkill(null);
      setStreamingActivatedSkills([]);
      setStreamingThinking('');
      setStreamingToolCalls([]);
    }
  }, [loading, selectedAssistant, conversationId, modelId, pageAIContext, onConversationId]);

  const applyPendingChange = useCallback(async (pending: NotePendingChange, messageIndex?: number) => {
    if (!pending || pending.applied) return;
    if (messageIndex != null) setApplyingIndex(messageIndex);
    try {
      await noteApi.update(pending.noteId, {
        content: pending.proposedContent,
        title: pending.proposedTitle ?? undefined,
      });
      if (messageIndex != null) {
        setMessages(prev => prev.map((m, i) =>
          i === messageIndex && m.notePendingChange
            ? { ...m, notePendingChange: { ...m.notePendingChange, applied: true } }
            : m,
        ));
      }
      bumpNotesRefresh();
      toast.success('已应用到笔记');
    } catch {
      toast.error('应用失败');
    } finally {
      if (messageIndex != null) setApplyingIndex(null);
    }
  }, [bumpNotesRefresh]);

  const handleApply = useCallback(async (index: number) => {
    const msg = messages[index];
    const pending = msg?.notePendingChange;
    if (!pending || pending.applied) return;
    await applyPendingChange(pending, index);
  }, [messages, applyPendingChange]);

  const handleApplyStreaming = useCallback(async () => {
    if (!streamingPending || streamingPending.applied) return;
    await applyPendingChange(streamingPending);
    setStreamingPending(prev => prev ? { ...prev, applied: true } : null);
  }, [streamingPending, applyPendingChange]);

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

  const loadMessagesFromHistory = useCallback((raw: Array<{
    role: string;
    content: string;
    toolResults?: Array<{ result: Record<string, unknown> }>;
    attachments?: unknown;
    attachmentIds?: string[];
  }>) => {
    setMessages(raw.map(m => {
      let notePendingChange: NotePendingChange | undefined;
      if (m.role === 'assistant' && m.toolResults) {
        for (const tr of m.toolResults) {
          const rawResult = (tr as { result?: Record<string, unknown> }).result ?? tr as Record<string, unknown>;
          const parsed = parseNotePendingChange(rawResult);
          if (parsed && !parsed.applied) {
            notePendingChange = parsed;
            break;
          }
        }
      }
      const attachments = mapApiMessageAttachments(m.attachments);
      const displayContent = m.role === 'user' ? stripAttachmentMarkers(m.content) : m.content;
      return {
        role: m.role as 'user' | 'assistant',
        content: displayContent,
        attachments: attachments.length > 0 ? attachments : undefined,
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
    streamingActivatedSkills,
    streamingThinking,
    streamingToolCalls,
    applyingIndex,
    sendMessage,
    handleApply,
    handleApplyStreaming,
    handleConfirmDelete,
    handleDismiss,
    loadMessagesFromHistory,
    streamingPending,
    setStreamingPending,
    stopGeneration,
  };
}
